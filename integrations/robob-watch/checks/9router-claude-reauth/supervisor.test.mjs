import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { acquireLease, leaseOwner, releaseLease } from './lease.mjs';
import { assertCleared, assertIncident, lazyControlClient, liveProviders, notificationId, notificationState, pendingConnections, phaseReporter, readState, runBoundedCommand, runObserved, telegramHealthy, threadIdFor, tick, workerPrompt, writeState } from './supervisor.mjs';

const HAS_LOCKF = process.platform === 'darwin' && existsSync('/usr/bin/lockf');
const LOCKF_SKIP_REASON = 'needs macOS /usr/bin/lockf (watcher is macOS-only)';
const lockfOnly = { skip: !HAS_LOCKF && LOCKF_SKIP_REASON };
// Bun honors node:test skips but omits their reason from its reporter.
if (!HAS_LOCKF) console.info(`Skipping lease tests: ${LOCKF_SKIP_REASON}`);

const testLogDir = mkdtempSync(join(tmpdir(), 'reauth-logs-'));
const previousLogDir = process.env.ROUTER_LOG_DIR;
process.env.ROUTER_LOG_DIR = testLogDir;
after(() => {
  if (previousLogDir === undefined) delete process.env.ROUTER_LOG_DIR; else process.env.ROUTER_LOG_DIR = previousLogDir;
  rmSync(testLogDir, { recursive: true, force: true });
});

const MODEL = { instanceId: 'opencode', model: 'opus/cx/gpt-6.1-terra', variant: 'max' };
const good = (id = 'alpha') => ({ id, provider: 'claude', authType: 'oauth', isActive: true });
const bad = (id = 'alpha', mark = '2026-11-01T00:00:00.000Z') => ({ ...good(id), reauthRequiredAt: mark });

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), leasePath = join(dir, 'lease');
  const sim = { time: 1_000_000, rows: [bad()], threads: new Map(), creates: [], alerts: [], outbox: new Map(), lookups: [], providerCalls: 0 };
  const ctx = {
    now: () => sim.time, load: () => readState(path), save: s => writeState(path, s),
    providers: async () => { sim.providerCalls++; if (sim.providerError) throw new Error('down'); return { connections: sim.rows }; },
    leasePath, leaseOwner: () => leaseOwner(leasePath), acquireLease: id => acquireLease(leasePath, 'auto', id), releaseLease: o => releaseLease(leasePath, o),
    available: async () => { if (sim.healthError) throw new Error('down'); return true; },
    notificationAvailable: async () => { if (sim.notificationHealthError) throw new Error('down'); return true; },
    thread: async id => { sim.lookups.push(id); if (sim.threadError) throw new Error('down'); if (!sim.threads.has(id)) throw Object.assign(new Error('missing'), { status: 404 }); return { thread: sim.threads.get(id) }; },
    create: async body => {
      sim.creates.push(structuredClone(body));
      const id = threadIdFor(body.clientRequestId);
      if (!sim.threads.has(id) && !sim.noCreate) {
        const run = { runId: 'run-1', status: 'running', model: MODEL };
        sim.threads.set(id, { threadId: id, state: 'running', status: 'running', model: MODEL, run, recentRuns: [run] });
      }
      if (sim.createError) throw new Error('connection lost');
      const response = { threadId: id, runId: 'run-1', status: 'running', model: MODEL };
      if (sim.badModel) response.model = { ...MODEL, variant: 'high' };
      return response;
    },
    lastAssistant: async () => sim.answer ?? 'REAUTH_RESULT: NOT_CLEARED',
    notify: async (key, text) => { sim.alerts.push({ key, text }); if (sim.notifyError) throw new Error('bridge down'); const id = notificationId(key); if (!sim.outbox.has(id)) sim.outbox.set(id, 'sent'); return { id, created: true }; },
    notificationState: async key => notificationState({ notifications: [...sim.outbox].map(([id, state]) => ({ id, state })) }, key),
    notificationSnapshot: async () => ({ notifications: [...sim.outbox].map(([id, state]) => ({ id, state })) }),
  };
  return { sim, ctx, path, leasePath, state: () => readState(path), tick: () => tick(ctx),
    complete: (status = 'completed') => { const a = readState(path).active; const v = sim.threads.get(a.threadId); v.state = 'idle'; v.status = status; v.run.status = status; },
  };
}

test('startup already-bad launches one exact worker after a fresh check with explicit model', lockfOnly, async t => {
  const h = harness(t); await h.tick();
  assert.equal(h.sim.creates.length, 1); assert.equal(h.sim.providerCalls, 2);
  const b = h.sim.creates[0]; assert.equal(b.model, MODEL.model); assert.equal(b.variant, 'max'); assert.equal(b.providerInstanceId, 'opencode');
  assert.match(b.prompt, /reauthConnectionId/); assert.match(b.prompt, /label is not an account identity/); assert.match(b.prompt, /same effective reauthRequiredAt/);
  assert.equal(h.state().active.phase, 'sent'); assert.equal(h.state().incidents[0].attempts, 1);
  assert.equal(h.sim.lookups[0], threadIdFor(b.clientRequestId));
});

test('healthy-to-bad-to-healthy transition; marker, not status label, decides completion', lockfOnly, async t => {
  const h = harness(t); h.sim.rows = [{ ...good(), testStatus: 'expired', errorCode: 401 }]; await h.tick(); assert.equal(h.sim.creates.length, 0);
  h.sim.rows = [{ ...bad(), testStatus: 'active' }]; await h.tick(); assert.equal(h.sim.creates.length, 1);
  h.complete(); h.sim.rows = [{ ...good(), testStatus: 'expired' }]; await h.tick();
  assert.equal(h.state().active, null); assert.equal(leaseOwner(h.leasePath), null); assert.equal(h.sim.alerts.length, 0);
});

test('ignore nonauth, 429, disabled, wrong provider/auth and effective stale marker', () => {
  assert.deepEqual(pendingConnections({ connections: [
    { ...good('rate'), errorCode: 429, testStatus: 'expired' },
    { ...bad('disabled'), isActive: false }, { ...bad('other'), provider: 'codex' }, { ...bad('apikey'), authType: 'apikey' },
    // This is the API result after its fingerprint reconciliation dropped the stale raw mark.
    { ...good('stale'), testStatus: 'expired' }, bad('really-bad'),
  ] }), [{ accountId: 'really-bad', marker: '2026-11-01T00:00:00.000Z' }]);
  assert.throws(() => pendingConnections({ error: 'unavailable' }));
  assert.equal(assertIncident({ connections: [bad()] }, 'alpha', bad().reauthRequiredAt), true);
  assert.equal(assertIncident({ connections: [good()] }, 'alpha', bad().reauthRequiredAt), false);
  assert.equal(assertCleared({ connections: [good()] }, 'alpha'), true);
  assert.equal(assertCleared({ connections: [bad()] }, 'alpha'), false);
  assert.throws(() => assertCleared({ connections: [] }, 'alpha'));
  assert.throws(() => assertCleared({ connections: [{ ...good(), isActive: false }] }, 'alpha'));
  assert.throws(() => pendingConnections({ connections: [{ provider: 'claude', id: 'alpha', reauthRequiredAt: bad().reauthRequiredAt }] }));
  assert.throws(() => pendingConnections({ connections: [bad('evil\ninjected')] }));
});

test('busy, waiting, queued and needs-input hold the global worker; only one attention', lockfOnly, async t => {
  const h = harness(t); h.sim.rows = [bad('alpha'), bad('beta')]; await h.tick();
  const a = h.state().active, thread = h.sim.threads.get(a.threadId);
  for (const state of ['running', 'waiting', 'queued', 'needs-input', 'needs-input']) { thread.state = state; await h.tick(); }
  assert.equal(h.sim.creates.length, 1); assert.equal(h.sim.alerts.length, 1); assert.equal(h.state().active.threadId, a.threadId);
  h.complete(); await h.tick(); assert.equal(h.state().incidents.find(i => i.accountId === 'alpha').blocked, true);
  await h.tick(); assert.equal(h.sim.creates.length, 2); assert.match(h.sim.creates[1].prompt, /Connection ID: beta/);
});

test('terminal not-cleared retries after 5 and 15 minutes, then alerts once and blocks', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete(); await h.tick();
  await h.tick(); assert.equal(h.sim.creates.length, 1);
  h.sim.time += 5 * 60_000; await h.tick(); assert.equal(h.sim.creates.length, 2); h.complete(); await h.tick();
  h.sim.time += 15 * 60_000 - 1; await h.tick(); assert.equal(h.sim.creates.length, 2);
  h.sim.time++; await h.tick(); h.complete(); await h.tick(); await h.tick();
  assert.equal(h.sim.creates.length, 3); assert.equal(h.sim.alerts.length, 1); assert.equal(h.state().incidents[0].blocked, true);
  assert.equal(new Set(h.sim.creates.map(x => x.clientRequestId)).size, 3);
});

test('human action terminal blocks without blind retry, bridge replay uses stable payload', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete(); h.sim.answer = 'REAUTH_RESULT: HUMAN_ACTION_REQUIRED'; h.sim.notifyError = true;
  await assert.rejects(h.tick()); assert.equal(h.state().active.phase, 'finishing');
  h.sim.notifyError = false; await h.tick(); await h.tick();
  assert.deepEqual(h.sim.alerts[0], h.sim.alerts[1]); assert.equal(h.sim.creates.length, 1); assert.equal(h.state().active, null);
});

test('service down is an error and never healthy; malformed status is unknown', lockfOnly, async t => {
  const h = harness(t); h.sim.providerError = true; await assert.rejects(h.tick()); assert.equal(h.sim.creates.length, 0);
  h.sim.providerError = false; h.sim.healthError = true; await assert.rejects(h.tick());
  assert.equal(h.state().active, null); assert.equal(h.state().incidents[0].attempts, 0);
  h.sim.healthError = false; h.sim.notificationHealthError = true; await assert.rejects(h.tick());
  assert.equal(h.state().incidents[0].attempts, 0);
  h.sim.notificationHealthError = false; await h.tick(); h.sim.threadError = true; await assert.rejects(h.tick());
  assert.equal(h.sim.creates.length, 1); assert.ok(h.state().active);
});

test('lost launch response: status first finds original worker; no duplicate', lockfOnly, async t => {
  const h = harness(t); h.sim.createError = true; await assert.rejects(h.tick());
  assert.equal(h.state().active.phase, 'sent'); h.sim.createError = false; await h.tick();
  assert.equal(h.sim.creates.length, 1); assert.equal(h.sim.lookups.at(-1), h.state().active.threadId);
});

test('ambiguous no-thread retries same key only after cooldown, status before every send', lockfOnly, async t => {
  const h = harness(t); h.sim.noCreate = true; h.sim.createError = true; await assert.rejects(h.tick());
  await h.tick(); assert.equal(h.sim.creates.length, 1);
  for (let n = 0; n < 2; n++) { h.sim.time += 60_000; await assert.rejects(h.tick()); }
  h.sim.time += 60_000; await h.tick(); await h.tick();
  assert.equal(h.sim.creates.length, 3); assert.equal(new Set(h.sim.creates.map(x => x.clientRequestId)).size, 1);
  assert.equal(h.sim.alerts.length, 1); assert.ok(h.state().active); assert.ok(leaseOwner(h.leasePath));
});

test('crash between prepared state and lease acquisition resumes; manual holder wins race', lockfOnly, async t => {
  const h = harness(t); let once = true; const acquire = h.ctx.acquireLease;
  h.ctx.acquireLease = id => { if (once) { once = false; throw new Error('crash'); } return acquire(id); };
  await assert.rejects(h.tick()); assert.equal(h.state().active.phase, 'prepared'); assert.equal(leaseOwner(h.leasePath), null);
  const manual = acquireLease(h.leasePath, 'manual'); await h.tick(); assert.equal(h.sim.creates.length, 0);
  assert.equal(releaseLease(h.leasePath, manual), true); await h.tick(); assert.equal(h.sim.creates.length, 1);
});

test('crash immediately after lease publish resumes with matching persisted owner', lockfOnly, async t => {
  const h = harness(t); let once = true; const acquire = h.ctx.acquireLease;
  h.ctx.acquireLease = id => { const v = acquire(id); if (once) { once = false; throw new Error('crash'); } return v; };
  await assert.rejects(h.tick()); assert.equal(leaseOwner(h.leasePath).id, h.state().active.leaseId);
  await h.tick(); assert.equal(h.sim.creates.length, 1);
});

test('unexpected existing thread for an unsent attempt fails closed', lockfOnly, async t => {
  const h = harness(t); h.ctx.acquireLease = () => { throw new Error('crash'); }; await assert.rejects(h.tick());
  const active = h.state().active;
  h.sim.threads.set(active.threadId, { threadId: active.threadId, state: 'idle', model: MODEL, run: { runId: 'old', status: 'completed', model: MODEL } });
  h.ctx.acquireLease = id => acquireLease(h.leasePath, 'auto', id);
  await h.tick(); assert.equal(h.sim.creates.length, 0); assert.equal(h.sim.alerts.length, 1); assert.ok(h.state().active);
});

test('fresh recheck cancels prepared attempt if disabled, repaired, or incident changed', lockfOnly, async t => {
  for (const changed of [{ ...bad(), isActive: false }, good(), bad('alpha', '2026-11-01T00:01:00.000Z')]) {
    const h = harness(t); let n = 0;
    h.ctx.providers = async () => ({ connections: [++n === 1 ? bad() : changed] });
    await h.tick(); assert.equal(h.sim.creates.length, 0); assert.equal(h.state().active, null); assert.equal(leaseOwner(h.leasePath), null);
  }
});

test('prepared recovery sees manual fix and never touches manual lease', lockfOnly, async t => {
  const h = harness(t); h.ctx.acquireLease = () => { throw new Error('crash'); }; await assert.rejects(h.tick());
  const manual = acquireLease(h.leasePath, 'manual'); h.sim.rows = [good()]; await h.tick();
  assert.equal(h.state().active, null); assert.equal(h.state().incidents[0].attempts, 0);
  assert.equal(leaseOwner(h.leasePath).id, manual.id); assert.equal(h.sim.creates.length, 0);
  releaseLease(h.leasePath, manual);
});

test('model mismatch holds active worker and alerts; cannot start another', lockfOnly, async t => {
  const h = harness(t); h.sim.badModel = true; await assert.rejects(h.tick());
  await h.tick(); assert.equal(h.sim.creates.length, 1); assert.equal(h.sim.alerts.length, 1); assert.equal(h.state().incidents[0].blocked, true);
});

test('a mismatching model on the status response is held and alerted', lockfOnly, async t => {
  const h = harness(t); await h.tick();
  const thread = h.sim.threads.get(h.state().active.threadId);
  thread.run.model = { ...MODEL, instanceId: 'claudeAgent' };
  await h.tick(); await h.tick(); assert.equal(h.sim.creates.length, 1); assert.equal(h.sim.alerts.length, 1); assert.equal(h.state().incidents[0].blocked, true);
});

test('lease is exclusive, only owner releases, invalid lease fails closed', lockfOnly, t => {
  const h = harness(t); const a = acquireLease(h.leasePath, 'manual');
  assert.equal(acquireLease(h.leasePath, 'auto'), null); assert.equal(releaseLease(h.leasePath, { ...a, id: 'other' }), false);
  assert.equal(releaseLease(h.leasePath, a), true);
  writeFileSync(h.leasePath, 'not a lease'); assert.equal(leaseOwner(h.leasePath).kind, 'unknown');
});

test('fd-owned guard is nonblocking and remains held until mutation process exits', lockfOnly, async t => {
  const h = harness(t); const guard = `${h.leasePath}.guard`;
  const child = spawn('/bin/sh', ['-c', 'exec 9>>"$1"; /usr/bin/lockf -s -t 0 9 || exit 1; printf "ready\\n"; exec "$2" -e "process.stdin.resume()"', 'lease-test', guard, process.execPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`guard exited early ${code}`))); });
  const source = readFileSync(fileURLToPath(new URL('./lease.mjs', import.meta.url)), 'utf8');
  assert.match(source, /lockf -s -t 0 9/); assert.doesNotMatch(source, /timeout:\s*7_000/);
  assert.throws(() => acquireLease(h.leasePath, 'auto')); assert.equal(leaseOwner(h.leasePath), null);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end(); await exited;
  const owner = acquireLease(h.leasePath, 'auto'); assert.ok(owner); assert.equal(releaseLease(h.leasePath, owner), true);
});

test('held runner and scratch-copy checks refuse live access', t => {
  const h = harness(t); const source = fileURLToPath(new URL('./check.sh', import.meta.url));
  const copy = join(h.leasePath, '..', 'check.sh'); writeFileSync(copy, readFileSync(source), { mode: 0o700 });
  const result = spawnSync('/bin/sh', [copy], { env: { ...process.env, WATCH_DIR: join(h.leasePath, '..') }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Refusing live check outside its exact watcher directory/);
  const shell = readFileSync(source, 'utf8'); assert.match(shell, /ENABLE_REQUIRED/); assert.match(shell, /exit 0/);
});

test('journal rejects corrupt state rather than restarting empty', t => {
  const h = harness(t); writeFileSync(h.path, '{'); assert.throws(() => readState(h.path));
  writeFileSync(h.path, JSON.stringify({ version: 1, incidents: [], active: { phase: 'sent' } })); assert.throws(() => readState(h.path));
});

test('journal does not store auth secrets from provider response', lockfOnly, async t => {
  const h = harness(t); h.sim.rows = [{ ...bad(), reauthTokenHash: 'do-not-store-hash', accessToken: 'do-not-store-secret', name: 'misleading-label' }];
  await h.tick(); const s = readFileSync(h.path, 'utf8');
  assert.doesNotMatch(s, /do-not-store|misleading-label/); assert.doesNotMatch(JSON.stringify(h.sim.creates), /do-not-store|misleading-label/);
});

test('crash after release, before final state save resumes without repeating outcome', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete(); let once = true; const save = h.ctx.save;
  h.ctx.save = s => { if (once && s.active === null) { once = false; throw new Error('crash'); } save(s); };
  await assert.rejects(h.tick()); assert.equal(h.state().active.phase, 'finishing'); assert.equal(leaseOwner(h.leasePath), null);
  const nextAt = h.state().incidents[0].nextAt; h.sim.time += 2 * 60_000;
  await h.tick(); assert.equal(h.state().active, null); assert.equal(h.state().incidents[0].nextAt, nextAt); assert.equal(h.sim.creates.length, 1);
});

test('unknown create result or missing model cannot be treated as verified', lockfOnly, async t => {
  const h = harness(t); const create = h.ctx.create;
  h.ctx.create = async body => { await create(body); return null; };
  await assert.rejects(h.tick()); assert.equal(h.state().incidents[0].blocked, false);
  const thread = h.sim.threads.get(h.state().active.threadId); thread.model = undefined;
  await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 0); assert.ok(h.state().active);
});

test('incident change after uncertain send stays held and requests attention instead of a duplicate', lockfOnly, async t => {
  const h = harness(t); h.sim.noCreate = true; h.sim.createError = true; await assert.rejects(h.tick());
  h.sim.rows = [good()]; await h.tick(); await h.tick();
  assert.equal(h.sim.alerts.length, 1); assert.equal(h.sim.creates.length, 1); assert.ok(h.state().active);
});

test('blocked incident remains blocked if disabled and re-enabled with the same marker', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete(); h.sim.answer = 'REAUTH_RESULT: HUMAN_ACTION_REQUIRED'; await h.tick();
  assert.equal(h.state().incidents[0].blocked, true);
  h.sim.rows = [{ ...bad(), isActive: false }]; await h.tick(); assert.equal(h.state().incidents.length, 1);
  h.sim.rows = [bad()]; await h.tick(); assert.equal(h.sim.creates.length, 1); assert.equal(h.state().incidents[0].attempts, 1);
});

test('worker prompt requires exact-token post-reauth identity and real pinned inference without refresh', () => {
  const p = workerPrompt({ accountId: 'alpha', marker: bad().reauthRequiredAt }, { leaseId: 'owner' }, '/tmp/synthetic-lease');
  for (const phrase of [
    'read-only exact-ID lookup', 'currently attached access token', 'read-only OAuth profile endpoint',
    'independently established intended identity', 'providerConnections row', 'Read/use the token and profile in memory',
    'ONE minimal real inference request pinned to that same exact currently attached access token',
    'real upstream and return a valid assistant response', 'No account pool, generic router chat fallback',
    'Never force a token refresh', 'The 9router provider test route may refresh or mutate state: do not use it',
    'if safe pinning is unavailable, skip it and report CLEARED_UNVERIFIED', 'compare the token in memory',
    'Never refresh tokens or repeat OAuth/login because of a mere 429',
    'If the same original marker remains after a 429, return REAUTH_RESULT: HUMAN_ACTION_REQUIRED',
    'do not place credentials in command arguments, environment variables, files, logs, output, URLs or tool results',
    '--assert-cleared alpha', 'Do not equate a cleared marker with verified working',
  ]) assert.ok(p.includes(phrase), `missing prompt guard: ${phrase}`);
});

test('live safety fence enters detector-only mode regardless of fake capability flags and prompt refuses reauth', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  h.ctx.serverFenceVerified = true; h.ctx.capability = { enabled: true, verified: true };
  h.ctx.create = () => { throw new Error('unsafe launch'); }; h.ctx.acquireLease = () => { throw new Error('unsafe lease'); };
  await h.tick(); assert.equal(h.sim.providerCalls, 1); assert.equal(h.sim.creates.length, 0); assert.equal(h.sim.alerts.length, 1); assert.equal(leaseOwner(h.leasePath), null);
  const p = workerPrompt({ accountId: 'alpha', marker: bad().reauthRequiredAt }, { leaseId: 'owner' }, '/tmp/synthetic-lease');
  assert.match(p, /^SAFETY HOLD:/); assert.match(p, /Do not call ANY existing 9router OAuth reauth\/exchange endpoint/);
  assert.match(p, /do not submit an OAuth flow/); assert.match(p, /do not write, replace, clear, or attach credentials/);
  assert.match(p, /Stop now with REAUTH_RESULT: HUMAN_ACTION_REQUIRED/);
  assert.match(p, /no manual confirmation or local boolean\/file may waive it/);
});

test('detector starts with already-bad markers, notifies once per ID/marker and does not rearm on transient absence', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.rows = [bad('alpha'), bad('beta')];
  h.ctx.create = () => { throw new Error('unsafe launch'); }; h.ctx.acquireLease = () => { throw new Error('unsafe lease'); };
  await h.tick(); assert.equal(h.sim.alerts.length, 2); assert.equal(h.state().detectorIncidents.length, 2);
  await h.tick(); h.sim.rows = [good('alpha'), { ...bad('beta'), isActive: false }]; await h.tick();
  h.sim.rows = [bad('alpha'), bad('beta')]; await h.tick(); assert.equal(h.sim.alerts.length, 2);
  h.sim.rows = [bad('alpha', '2026-11-01T00:01:00.000Z'), bad('beta')]; await h.tick();
  assert.equal(h.sim.alerts.length, 3); assert.equal(h.sim.creates.length, 0); assert.equal(leaseOwner(h.leasePath), null);
});

test('detector healthy accounts emit no alerts or require Telegram readiness', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.notificationHealthError = true;
  h.sim.rows = [{ ...good(), errorCode: 429 }, { ...bad('disabled'), isActive: false }, { ...bad('codex'), provider: 'codex' }];
  await h.tick(); assert.equal(h.sim.alerts.length, 0); assert.equal(h.state().detectorIncidents.length, 0);
});

test('detector gates unhealthy Telegram, retries pending outbox and exposes failed, uncertain or missing', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.notificationHealthError = true;
  await assert.rejects(h.tick()); const stable = h.state().detectorIncidents[0].id; assert.equal(h.sim.alerts.length, 0);
  h.sim.notificationHealthError = false; const notify = h.ctx.notify;
  h.ctx.notify = async (key, text) => { const r = await notify(key, text); h.sim.outbox.set(r.id, 'pending'); return r; };
  await h.tick(); assert.equal(h.state().detectorIncidents[0].id, stable); assert.equal(h.sim.alerts.length, 1);
  const id = notificationId(h.sim.alerts[0].key); h.sim.outbox.set(id, 'sending'); await h.tick(); assert.equal(h.sim.alerts.length, 1);
  for (const status of ['failed', 'uncertain']) { h.sim.outbox.set(id, status); await assert.rejects(h.tick()); }
  h.sim.outbox.delete(id); await assert.rejects(h.tick()); h.sim.outbox.set(id, 'sent'); await h.tick();
  assert.equal(h.state().detectorIncidents[0].alertState, 'sent'); assert.equal(h.sim.alerts.length, 1);
});

test('detector checks pending/sending health and fails at three minutes without requeueing, then recovers on sent', async t => {
  for (const status of ['pending', 'sending']) {
    const h = harness(t); h.ctx.enforceSafetyFence = true;
    const send = h.ctx.notify;
    h.ctx.notify = async (key, text) => { const r = await send(key, text); h.sim.outbox.set(r.id, status); return r; };
    await h.tick(); const record = h.state().detectorIncidents[0], id = notificationId(h.sim.alerts[0].key);
    assert.equal(record.firstEnqueuedAt, h.sim.time); assert.equal(record.alertState, 'pending');
    h.sim.time += 179_999; await h.tick(); assert.equal(h.sim.alerts.length, 1);
    h.sim.notificationHealthError = true; await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 1);
    h.sim.notificationHealthError = false; h.sim.time++; await assert.rejects(h.tick());
    assert.equal(h.state().detectorIncidents[0].firstEnqueuedAt, record.firstEnqueuedAt);
    h.sim.time += 500_000; await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 1);
    h.sim.outbox.set(id, 'sent'); await h.tick(); assert.equal(h.state().detectorIncidents[0].alertState, 'sent');
  }
});

test('a degraded bridge fails while delivery is pending even without an exception', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  const send = h.ctx.notify;
  h.ctx.notify = async (key, text) => { const r = await send(key, text); h.sim.outbox.set(r.id, 'pending'); return r; };
  await h.tick(); h.ctx.notificationAvailable = async () => false;
  await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 1);
});

test('detector processes new incidents before raising on expired pending delivery', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  const send = h.ctx.notify;
  h.ctx.notify = async (key, text) => { const r = await send(key, text); if (h.sim.alerts.length === 1) h.sim.outbox.set(r.id, 'pending'); return r; };
  await h.tick(); h.sim.time += 180_000; h.sim.rows = [bad('alpha'), bad('beta')];
  await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 2);
  assert.match(h.sim.alerts[1].text, /beta/); assert.equal(h.sim.creates.length, 0);
});

test('detector records first enqueue before ambiguous send, preserves clock on replay and fails closed on old state', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.notifyError = true;
  await assert.rejects(h.tick()); const first = h.state().detectorIncidents[0].firstEnqueuedAt;
  assert.equal(first, h.sim.time); h.sim.time += 180_000; h.sim.notifyError = false;
  const send = h.ctx.notify;
  h.ctx.notify = async (key, text) => { const r = await send(key, text); h.sim.outbox.set(r.id, 'pending'); return r; };
  await assert.rejects(h.tick()); assert.equal(h.state().detectorIncidents[0].firstEnqueuedAt, first);
  const state = h.state(); delete state.detectorIncidents[0].firstEnqueuedAt; h.ctx.save(state);
  await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 2);
});

test('legacy notified record without alertState normalizes observed pending/sending and fails closed on missing timestamp', async t => {
  for (const rowState of ['pending', 'sending']) {
    for (const kind of ['detector', 'recovery']) {
      const h = harness(t); h.ctx.enforceSafetyFence = true;
      const state = h.state();
      const id = `legacy-${kind}-${rowState}`;
      const incident = { id, accountId: 'alpha', marker: bad().reauthRequiredAt, notified: true };
      if (kind === 'detector') state.detectorIncidents = [{ ...incident, kind: 'detector' }];
      else state.incidents = [{ ...incident, attempts: 1, nextAt: 0, blocked: true }];
      h.ctx.save(state);
      const key = `${kind === 'detector' ? '9router-claude-detector' : '9router-claude-reauth'}:${id}`;
      h.sim.outbox.set(notificationId(key), rowState);
      await assert.rejects(h.tick(), /detector notification delivery/);
      const saved = h.state();
      const record = kind === 'detector' ? saved.detectorIncidents[0] : saved.incidents[0];
      assert.equal(record.alertState, 'pending'); assert.equal(record.firstEnqueuedAt, undefined);
      assert.equal(h.sim.alerts.length, 0); assert.equal(h.sim.creates.length, 0);
      h.sim.outbox.set(notificationId(key), 'sent'); await h.tick();
      const final = h.state(); assert.equal((kind === 'detector' ? final.detectorIncidents[0] : final.incidents[0]).alertState, 'sent');
    }
  }
});

test('control-client loader is lazy and detector never loads it even if unavailable', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; let loads = 0;
  const control = lazyControlClient(async () => { loads++; throw new Error('ExternalSSD unavailable'); });
  h.ctx.available = async () => (await control()).health();
  h.ctx.thread = async id => (await control()).thread(id);
  h.ctx.create = async body => (await control()).createThread(body);
  h.sim.rows = [bad()]; await h.tick(); await h.tick();
  assert.equal(loads, 0); assert.equal(h.sim.alerts.length, 1); assert.equal(h.sim.creates.length, 0);
  await assert.rejects(control()); assert.equal(loads, 1);
});

test('detector delivers a new incident even if an older outbox row failed; no duplicate or worker', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.rows = [bad('alpha')];
  h.ctx.create = () => { throw new Error('must not launch'); };
  const send = h.ctx.notify;
  h.ctx.notify = async (key, text) => { const response = await send(key, text); if (h.sim.alerts.length === 1) h.sim.outbox.set(response.id, 'pending'); return response; };
  await h.tick(); const failedId = notificationId(h.sim.alerts[0].key); h.sim.outbox.set(failedId, 'failed');
  h.sim.rows = [bad('alpha'), bad('beta')]; await assert.rejects(h.tick());
  assert.equal(h.sim.alerts.length, 2); assert.match(h.sim.alerts[1].text, /beta/);
  assert.equal(h.state().detectorIncidents.find(x => x.accountId === 'beta').alertState, 'pending');
  await assert.rejects(h.tick()); assert.equal(h.state().detectorIncidents.find(x => x.accountId === 'beta').alertState, 'sent');
  assert.equal(h.sim.alerts.length, 2); assert.equal(h.sim.creates.length, 0);
});

test('detector checks pending delivery after the marker disappears and never requeues the same marker', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  const send = h.ctx.notify; h.ctx.notify = async (key, text) => { const r = await send(key, text); h.sim.outbox.set(r.id, 'pending'); return r; };
  await h.tick(); const id = notificationId(h.sim.alerts[0].key); h.sim.rows = [good()];
  h.sim.outbox.set(id, 'failed'); await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 1);
  h.sim.outbox.set(id, 'sent'); await h.tick(); h.sim.rows = [{ ...bad(), isActive: false }]; await h.tick();
  h.sim.rows = [bad()]; h.sim.time += 10_000_000; await h.tick();
  assert.equal(h.sim.alerts.length, 1); assert.equal(h.state().detectorIncidents.length, 1); assert.equal(h.sim.creates.length, 0);
});

test('detector send ambiguity preserves stable identity and payload across crash/retry', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.notifyError = true;
  await assert.rejects(h.tick()); const i = h.state().detectorIncidents[0]; assert.equal(i.notified, false);
  h.sim.notifyError = false; await h.tick(); assert.deepEqual(h.sim.alerts[0], h.sim.alerts[1]);
  assert.equal(h.state().detectorIncidents[0].id, i.id); assert.equal(h.sim.creates.length, 0);
});

test('ambiguous enqueue followed by cleared marker reconciles outbox and never sends a stale notice', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  const send = h.ctx.notify;
  h.ctx.notify = async (key, text) => { await send(key, text); throw new Error('reply lost'); };
  await assert.rejects(h.tick()); assert.equal(h.state().detectorIncidents[0].mayHaveQueued, true);
  const id = notificationId(h.sim.alerts[0].key); h.sim.rows = [good()]; h.sim.outbox.set(id, 'pending');
  await h.tick(); assert.equal(h.state().detectorIncidents[0].alertState, 'pending'); assert.equal(h.sim.alerts.length, 1);
  h.sim.outbox.set(id, 'sent'); await h.tick(); assert.equal(h.state().detectorIncidents[0].alertState, 'sent');
  h.sim.rows = [bad()]; await h.tick(); assert.equal(h.sim.alerts.length, 1);
});

test('ambiguous enqueue with cleared marker and absent outbox fails closed, not a stale send', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.notifyError = true;
  await assert.rejects(h.tick()); h.sim.rows = [good()]; h.sim.notifyError = false;
  await assert.rejects(h.tick()); await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 1);
});

test('detector leaves existing account budgets unchanged and fails closed on prior active worker', lockfOnly, async t => {
  const h = harness(t); await h.tick(); const before = h.state(); h.ctx.enforceSafetyFence = true;
  await assert.rejects(h.tick()); const after = h.state();
  assert.deepEqual(after.incidents, before.incidents); assert.deepEqual(after.active, before.active); assert.ok(leaseOwner(h.leasePath));
  assert.equal(h.sim.creates.length, 1);
});

test('detector provider outage is unknown and produces no notification or worker', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true; h.sim.providerError = true;
  await assert.rejects(h.tick()); assert.equal(h.sim.alerts.length, 0); assert.equal(h.sim.creates.length, 0);
});

test('detector queues at most three incidents per tick using one outbox snapshot', async t => {
  const h = harness(t); h.ctx.enforceSafetyFence = true;
  h.sim.rows = Array.from({ length: 8 }, (_, n) => bad(`account${n}`));
  h.ctx.create = () => { throw new Error('must not launch'); }; let snapshots = 0;
  const snapshot = h.ctx.notificationSnapshot; h.ctx.notificationSnapshot = async () => { snapshots++; return snapshot(); };
  await h.tick(); assert.equal(h.sim.alerts.length, 3); assert.equal(h.state().detectorIncidents.length, 8); assert.equal(snapshots, 0);
  await h.tick(); assert.equal(h.sim.alerts.length, 6); assert.equal(snapshots, 1);
  await h.tick(); assert.equal(h.sim.alerts.length, 8); assert.equal(snapshots, 2);
  await h.tick(); assert.equal(snapshots, 3); assert.ok(h.state().detectorIncidents.every(i => i.alertState === 'sent'));
});

test('worker prompt preserves supervisor markers and requires a separate reasoned verification report', () => {
  const p = workerPrompt({ accountId: 'alpha', marker: bad().reauthRequiredAt }, { leaseId: 'owner' }, '/tmp/synthetic-lease');
  assert.match(p, /return REAUTH_RESULT: CLEARED only when the effective marker is confirmed gone/);
  assert.match(p, /otherwise REAUTH_RESULT: NOT_CLEARED or REAUTH_RESULT: HUMAN_ACTION_REQUIRED/);
  assert.match(p, /VERIFICATION_RESULT: VERIFIED_WORKING \| CLEARED_UNVERIFIED \| NOT_VERIFIED/);
  assert.match(p, /VERIFICATION_REASON: NONE \| RATE_LIMITED \| PROFILE_UNAVAILABLE \| IDENTITY_MISMATCH/);
  assert.match(p, /VERIFIED_WORKING requires CLEARED, the post-reauth exact-token profile identity match, real pinned inference success/);
  assert.match(p, /For CLEARED with any missing, failed, rate-limited or uncertain verification, report CLEARED_UNVERIFIED/);
  assert.match(p, /If the marker was not confirmed cleared, report NOT_VERIFIED/);
});

test('cleared rate-limited or otherwise unverified report never starts another login', lockfOnly, async t => {
  for (const reason of ['RATE_LIMITED', 'PROFILE_UNAVAILABLE', 'IDENTITY_MISMATCH', 'PINNING_UNAVAILABLE', 'INFERENCE_FAILED', 'TOKEN_CHANGED']) {
    const h = harness(t); await h.tick(); h.complete(); h.sim.rows = [good()];
    h.sim.answer = `REAUTH_RESULT: CLEARED\nVERIFICATION_RESULT: CLEARED_UNVERIFIED\nVERIFICATION_REASON: ${reason}`;
    await h.tick(); await h.tick(); h.sim.time += 60 * 60_000; await h.tick();
    assert.equal(h.sim.creates.length, 1, reason); assert.equal(h.state().active, null); assert.equal(h.sim.alerts.length, 0);
  }
});

test('rate limit with still-pending marker and human-action result blocks relogin', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete();
  h.sim.answer = 'REAUTH_RESULT: HUMAN_ACTION_REQUIRED\nVERIFICATION_RESULT: NOT_VERIFIED\nVERIFICATION_REASON: RATE_LIMITED';
  await h.tick(); h.sim.time += 60 * 60_000; await h.tick();
  assert.equal(h.sim.creates.length, 1); assert.equal(h.state().incidents[0].blocked, true); assert.equal(h.sim.alerts.length, 1);
});

test('verified-working report does not override a still-present effective marker', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete();
  h.sim.answer = 'REAUTH_RESULT: CLEARED\nVERIFICATION_RESULT: VERIFIED_WORKING\nVERIFICATION_REASON: NONE';
  await h.tick(); assert.equal(h.state().incidents[0].attempts, 1); assert.equal(h.state().incidents[0].blocked, false);
  h.sim.time += 5 * 60_000; await h.tick(); assert.equal(h.sim.creates.length, 2);
});

test('actual cleared marker ends retry even when an old-style or missing report is returned', lockfOnly, async t => {
  for (const answer of ['REAUTH_RESULT: CLEARED', null, 'REAUTH_RESULT: NOT_CLEARED']) {
    const h = harness(t); await h.tick(); h.complete(); h.sim.rows = [good()]; h.sim.answer = answer;
    await h.tick(); h.sim.time += 60 * 60_000; await h.tick();
    assert.equal(h.sim.creates.length, 1); assert.equal(h.state().active, null);
  }
});

test('cancelled interrupted failed or rolled-back worker is held even if marker cleared; resume cannot release it', lockfOnly, async t => {
  for (const status of ['cancelled', 'interrupted', 'failed', 'rolled_back']) {
    const h = harness(t); await h.tick(); h.complete(status); h.sim.rows = [good()]; await h.tick();
    assert.equal(h.state().active.holdReason, 'worker-terminal-uncertain', status);
    assert.equal(h.state().incidents[0].blocked, true, status); assert.ok(leaseOwner(h.leasePath)); assert.equal(h.sim.alerts.length, 1);
    const thread = h.sim.threads.get(h.state().active.threadId); thread.run.status = 'completed';
    h.sim.time += 60 * 60_000; await h.tick(); assert.ok(h.state().active); assert.ok(leaseOwner(h.leasePath)); assert.equal(h.sim.creates.length, 1);
  }
});

test('idle null run partial acceptance is held and alerted once', lockfOnly, async t => {
  const h = harness(t); await h.tick(); const thread = h.sim.threads.get(h.state().active.threadId);
  thread.state = 'idle'; thread.run = null; thread.recentRuns = []; h.sim.rows = [good()];
  await h.tick(); await h.tick(); assert.equal(h.state().active.holdReason, 'partial-accept');
  assert.ok(leaseOwner(h.leasePath)); assert.equal(h.sim.alerts.length, 1); assert.equal(h.sim.creates.length, 1);
});

test('restart-resumed run cannot be mistaken for original completed run', lockfOnly, async t => {
  const h = harness(t); await h.tick(); const thread = h.sim.threads.get(h.state().active.threadId);
  thread.state = 'running'; thread.run = { runId: 'run-2', status: 'running', model: MODEL }; thread.recentRuns = [thread.run, { runId: 'run-1', status: 'failed', model: MODEL }];
  await h.tick(); assert.equal(h.state().active.holdReason, 'run-changed'); assert.equal(h.sim.alerts.length, 1); assert.ok(leaseOwner(h.leasePath));
});

test('when launch reply is lost multi-run history fails closed instead of adopting resumed run', lockfOnly, async t => {
  const h = harness(t); h.sim.createError = true; await assert.rejects(h.tick());
  const thread = h.sim.threads.get(h.state().active.threadId);
  thread.state = 'idle'; thread.run = { runId: 'run-2', status: 'completed', model: MODEL }; thread.recentRuns = [thread.run, { runId: 'run-1', status: 'failed', model: MODEL }];
  await h.tick(); assert.equal(h.state().active.holdReason, 'run-changed'); assert.ok(leaseOwner(h.leasePath)); assert.equal(h.sim.creates.length, 1);
});

test('Telegram health requires healthy ready paired enabled and connected', () => {
  const goodHealth = { status: 'healthy', ready: true, paired: true, enabled: true, telegramConnected: true };
  assert.equal(telegramHealthy(goodHealth), true);
  for (const key of ['ready', 'paired', 'enabled', 'telegramConnected']) assert.equal(telegramHealthy({ ...goodHealth, [key]: false }), false);
  for (const status of ['degraded', 'starting', 'ok', undefined]) assert.equal(telegramHealthy({ ...goodHealth, status }), false);
});

test('Telegram pending and sending are rechecked, only sent confirms, failure/disappearance fail closed', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete('failed');
  const original = h.ctx.notify; h.ctx.notify = async (key, text) => { const reply = await original(key, text); h.sim.outbox.set(reply.id, 'pending'); return reply; };
  await h.tick(); const id = notificationId(h.sim.alerts[0].key);
  assert.equal(h.state().incidents[0].alertState, 'pending'); h.sim.outbox.set(id, 'sending'); await h.tick();
  assert.equal(h.sim.alerts.length, 1); h.sim.outbox.set(id, 'failed'); await assert.rejects(h.tick(), /notification delivery failed or unknown/);
  h.sim.outbox.set(id, 'uncertain'); await assert.rejects(h.tick()); h.sim.outbox.delete(id); await assert.rejects(h.tick());
  h.sim.outbox.set(id, 'sent'); await h.tick(); assert.equal(h.state().incidents[0].alertState, 'sent'); assert.ok(h.state().active);
});

test('notification queue response must match dedupe id; ambiguous replay uses identical key', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete('failed'); h.sim.notifyError = true; await assert.rejects(h.tick());
  assert.ok(h.state().active); h.sim.notifyError = false; await h.tick();
  assert.deepEqual(h.sim.alerts[0], h.sim.alerts[1]); assert.equal(h.sim.alerts.length, 2);
});

test('marker changes retain account attempts and cooldown; after third attempt no further relogin', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete();
  h.sim.rows = [bad('alpha', '2026-11-01T00:01:00.000Z')]; await h.tick();
  assert.equal(h.state().incidents.length, 1); assert.equal(h.state().incidents[0].attempts, 1);
  await h.tick(); assert.equal(h.sim.creates.length, 1);
  h.sim.time += 5 * 60_000; await h.tick(); assert.equal(h.sim.creates.length, 2); h.complete();
  h.sim.rows = [bad('alpha', '2026-11-01T00:02:00.000Z')]; await h.tick();
  h.sim.time += 15 * 60_000; await h.tick(); assert.equal(h.sim.creates.length, 3); h.complete();
  h.sim.rows = [bad('alpha', '2026-11-01T00:03:00.000Z')]; await h.tick(); h.sim.time += 60 * 60_000; await h.tick();
  assert.equal(h.sim.creates.length, 3); assert.equal(h.state().incidents.length, 1); assert.equal(h.state().incidents[0].blocked, true); assert.equal(h.sim.alerts.length, 1);
});

test('marker clears then changes while disabled; budget and cooldown still apply', lockfOnly, async t => {
  const h = harness(t); await h.tick(); h.complete(); h.sim.rows = [good()]; await h.tick();
  h.sim.rows = [{ ...bad('alpha', '2026-11-01T00:01:00.000Z'), isActive: false }]; await h.tick();
  h.sim.rows = [bad('alpha', '2026-11-01T00:01:00.000Z')]; await h.tick(); assert.equal(h.sim.creates.length, 1);
  h.sim.time += 5 * 60_000; await h.tick(); assert.equal(h.sim.creates.length, 2); assert.equal(h.state().incidents[0].attempts, 2);
});


const supervisorUrl = new URL('./supervisor.mjs', import.meta.url).href;
const watcherPath = [join(process.env.HOME, '.local/share/robob-watch/helpers'), join(process.env.HOME, '.local/bin'), join(process.env.HOME, '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

function syntheticProcess(t, body, { dir, previous, minimal = true } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), 'reauth-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.mjs');
  const started = Date.now();
  writeFileSync(entry, `import { runObserved, phaseReporter, liveProviders, readState, writeState } from ${JSON.stringify(supervisorUrl)};\n${body}`);
  const child = spawn('/bin/zsh', ['-c', 'exec /usr/bin/env node "$1"', 'synthetic-check', entry], {
    cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(minimal ? {} : process.env), HOME: dir, PATH: watcherPath, LANG: 'en_US.UTF-8', WATCH_DIR: dir, WATCH_ID: '9router-claude-reauth', WATCH_RUN: 'synthetic', ...(previous === undefined ? {} : { WATCH_PREVIOUS_PHASE: previous }) },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const guard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5_000);
  const result = once(child, 'close').then(([code, signal]) => {
    clearTimeout(guard);
    return { code, signal, stdout, stderr, ms: Date.now() - started, dir };
  });
  return { result, dir };
}

function observedBody(providers, options = '') {
  return `const watchDir = process.env.WATCH_DIR;
const phase = phaseReporter(watchDir);
console.log(JSON.stringify({ startupMs: Date.now() - ${Date.now()}, first: JSON.parse((await import('node:fs')).readFileSync(watchDir + '/.phase', 'utf8')) }));
try {
  await runObserved({ enforceSafetyFence: true, now: Date.now,
    load: () => readState(watchDir + '/supervisor-state.json'),
    save: s => writeState(watchDir + '/supervisor-state.json', s),
    providers: ${providers},
  }, { phase, ${options} });
} catch { process.exitCode = 1; }`;
}

test('hung provider exits itself with providers and phase durations before runner timeout', async t => {
  const { result, dir } = syntheticProcess(t, observedBody('() => new Promise(() => {})', 'deadlineMs: 80'));
  const r = await result;
  assert.equal(r.code, 1); assert.equal(r.signal, null); assert.ok(r.ms < 2_000, r.ms);
  assert.match(r.stderr, /9router Claude detector: providers exceeded deadline/);
  assert.match(r.stderr, /phase durations: .*load=.*providers=/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.phase'))).phase, 'providers');
});

test('previous save/sh markers survive shell handoff; done and malformed markers are quiet', async t => {
  for (const phase of ['save', 'sh', 'done', 'malformed']) {
    const dir = mkdtempSync(join(tmpdir(), 'reauth-stale-'));
    const previous = phase === 'malformed' ? '{' : JSON.stringify({ phase, t: Date.now() - 5_000 });
    // The shell has replaced .phase with sh; its env preserves the prior run.
    writeFileSync(join(dir, '.phase'), JSON.stringify({ phase: 'sh', t: Date.now() }));
    const r = await syntheticProcess(t, observedBody('async () => ({ connections: [] })'), { dir, previous }).result;
    assert.equal(r.code, 0, r.stderr);
    if (phase === 'save' || phase === 'sh') assert.match(r.stderr, new RegExp(`previous run stalled in ${phase} [(]`));
    else assert.equal(r.stderr, '');
    assert.equal(JSON.parse(readFileSync(join(dir, '.phase'))).phase, 'done');
  }
  const dir = mkdtempSync(join(tmpdir(), 'reauth-stale-direct-'));
  writeFileSync(join(dir, '.phase'), JSON.stringify({ phase: 'save', t: Date.now() - 5_000 }));
  const r = await syntheticProcess(t, observedBody('async () => ({ connections: [] })'), { dir }).result;
  assert.equal(r.code, 0);
  assert.match(r.stderr.slice(-500), /previous run stalled in save/);
  assert.match(readFileSync(join(dir, 'log'), 'utf8'), /previous run stalled in save/);
  const next = await syntheticProcess(t, observedBody('async () => ({ connections: [] })'), { dir }).result;
  assert.equal(next.code, 0); assert.equal(next.stderr, '');
});

test('failure logs load/save timings, leaves failing marker, and never logs provider data', async t => {
  const h = harness(t), lines = [];
  h.ctx.enforceSafetyFence = true;
  h.ctx.save = () => { throw new Error('private payload'); };
  await assert.rejects(runObserved(h.ctx, { watchDir: h.path + '-missing', stderr: line => lines.push(line) }));
  assert.match(lines.join('\n'), /detector: save failed/);
  assert.match(lines.join('\n'), /phase durations: .*load=.*providers=.*save=/);
  assert.doesNotMatch(lines.join('\n'), /private payload/);
});

test('telegram bound survives a SIGTERM-ignoring child and grandchild holding stdout', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake.mjs');
  for (const parentExits of [false, true]) {
    writeFileSync(fake, `import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ['ignore', 1, 2] });
process.stdout.write('{"ok":true}');
${parentExits ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}`);
    const started = performance.now();
    const call = runBoundedCommand(process.execPath, [fake], { timeoutMs: 400 });
    if (parentExits) assert.deepEqual(JSON.parse(await call), { ok: true });
    else await assert.rejects(call, /timed out/);
    assert.ok(performance.now() - started < 1_500);
  }
  await assert.rejects(runBoundedCommand(join(dir, 'missing'), []), /unavailable/);
  await assert.rejects(runBoundedCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(300000))"]), /too large/);
});

async function routerStub(t, respond) {
  const server = createServer(respond);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/api/providers`;
}

function fakeAuth(dir) {
  mkdirSync(join(dir, 'auth'));
  writeFileSync(join(dir, 'machine-id'), 'synthetic-machine'); writeFileSync(join(dir, 'auth/cli-secret'), 'synthetic-secret');
}

test('fetch abort includes a body that stalls after successful response headers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-body-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); fakeAuth(dir);
  const url = await routerStub(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"connections":'); });
  const phases = [], started = performance.now();
  await assert.rejects(liveProviders({ data: dir, url, timeoutMs: 150, phase: p => phases.push(p) }), /abort|timeout/i);
  assert.equal(phases.at(-1), 'providers:body'); assert.ok(performance.now() - started < 1_500);
});

test('runner minimal env, ignored stdin, detached process and piped output finish within budget', async t => {
  const url = await routerStub(t, (req, res) => {
    assert.equal(req.url, '/api/providers'); assert.ok(req.headers['x-9r-cli-token']);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ connections: [], padding: 'x'.repeat(70_000) }));
  });
  const timings = [];
  for (const minimal of [true, false]) {
   for (let i = 0; i < 3; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'reauth-parity-')); fakeAuth(dir);
    const r = await syntheticProcess(t, observedBody(`phase => liveProviders({ data: process.env.WATCH_DIR, url: ${JSON.stringify(url)}, phase })`, 'deadlineMs: 2_000'), { dir, minimal }).result;
    assert.equal(r.code, 0, r.stderr); assert.ok(r.ms < 2_000, r.ms); assert.equal(r.stderr, '');
    const first = JSON.parse(r.stdout.trim()); assert.equal(first.first.phase, 'start');
    timings.push({ minimal, startupMs: first.startupMs, totalMs: r.ms });
   }
  }
  t.diagnostic(`runner-env startup/total ms: ${JSON.stringify(timings)}`);
});


test('telegram output remains complete across pipe buffers, unicode, and child exit', async () => {
  const text = 'é'.repeat(100_000);
  const output = await runBoundedCommand(process.execPath, ['-e', `process.stdout.write(JSON.stringify({ text: 'é'.repeat(100000) }))`]);
  assert.deepEqual(JSON.parse(output), { text });
  const controller = new AbortController();
  const call = runBoundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(call, /aborted/);
});

test('code-only installer preserves definition, state, lease, lock inode and phase marker', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['watcher.json', 'supervisor-state.json', 'state.json', 'log', '.run-ok', 'supervisor.lock', 'recovery.lease.guard', 'ENABLE_REQUIRED', '.phase'];
  for (const name of names) writeFileSync(join(dir, name), `keep ${name}`);
  const py = `import importlib.util, pathlib, os
spec = importlib.util.spec_from_file_location('installer', ${JSON.stringify(fileURLToPath(new URL('./install.py', import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
live = pathlib.Path(${JSON.stringify(dir)})
os.symlink('manual-owner', live / 'recovery.lease')
before = {p.name: (p.stat().st_ino, p.read_bytes()) for p in live.iterdir() if not p.is_symlink()}
m.install(live=live)
assert before == {name: ((live / name).stat().st_ino, (live / name).read_bytes()) for name in before}
assert os.readlink(live / 'recovery.lease') == 'manual-owner'
assert (live / 'check.sh').read_bytes() == (m.SOURCE / 'check.sh').read_bytes()
assert (live / 'supervisor.mjs').read_bytes() == (m.SOURCE / 'supervisor.mjs').read_bytes()
assert (live / 'check.sh').stat().st_mode & 0o777 == 0o700
assert (live / 'supervisor.mjs').stat().st_mode & 0o777 == 0o600
`;
  const r = spawnSync('/usr/bin/python3', ['-B', '-c', py], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(r.status, 0, r.stderr);
});


test('runner stderr tail retains stalled phase after many phase timings', t => {
  const h = harness(t), lines = [];
  const report = phaseReporter(h.path + '-missing', { previous: JSON.stringify({ phase: 'save', t: Date.now() - 10000 }), stderr: s => lines.push(s) });
  for (let i = 0; i < 100; i++) report.mark('save');
  report.mark('telegram:notifications');
  report.failure('exceeded deadline');
  const tail = lines.join('\n').slice(-500);
  assert.match(tail, /previous run stalled in save/);
  assert.match(tail, /9router Claude detector: telegram:notifications exceeded deadline/);
});


test('four failures followed by recovery remains successful and retains the stalled phase in log', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-recovery-'));
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const r = await syntheticProcess(t, observedBody('async () => { throw new Error("down"); }'), { dir }).result;
    codes.push(r.code);
    assert.match(r.stderr.slice(-500), /providers failed/);
  }
  const recovered = await syntheticProcess(t, observedBody('async () => ({ connections: [] })'), { dir }).result;
  codes.push(recovered.code);
  assert.deepEqual(codes, [1, 1, 1, 1, 0]);
  assert.match(recovered.stderr, /previous run stalled in providers/);
  assert.match(readFileSync(join(dir, 'log'), 'utf8'), /previous run stalled in providers/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.phase'))).phase, 'done');
  const next = await syntheticProcess(t, observedBody('async () => ({ connections: [] })'), { dir }).result;
  assert.equal(next.code, 0); assert.equal(next.stderr, '');
});

test('logging covers relogin needed, start, ok and fail while preserving the safety fence', lockfOnly, async t => {
  const { fixture } = await import('../../../router-logging/test/support.mjs');
  const { rows } = fixture(t);
  const h = harness(t);
  await h.tick();
  h.complete(); h.sim.rows = [good()]; await h.tick();
  h.sim.rows = [bad('another')]; h.sim.createError = true;
  await assert.rejects(h.tick, /launch outcome unknown/);
  for (const name of ['relogin.needed','relogin.start','relogin.ok','relogin.fail']) assert.ok(rows().some(r => r.name === name), name);
  const safe = harness(t); safe.ctx.enforceSafetyFence = true; await safe.tick();
  assert.equal(safe.sim.creates.length, 0);
  safe.sim.rows = [{ ...bad(), isActive: false }]; await safe.tick();
  assert.ok(!rows().some(r => r.props?.tag === 'marker_cleared_observed'));
  safe.sim.rows = [good()]; await safe.tick();
  assert.ok(rows().some(r => r.props?.tag === 'marker_cleared_observed'));
  assert.ok(!JSON.stringify(rows()).includes('REAUTH_RESULT'));
});
