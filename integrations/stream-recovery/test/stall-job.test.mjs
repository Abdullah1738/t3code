import './log-dir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, stall } from '../cli.mjs';
import * as realIo from '../lib/io.mjs';
import { pauseRecovery, resumeRecovery } from '../lib/pause.mjs';
import { restartScan } from '../lib/restartwatch.mjs';
import { fingerprint } from '../lib/stall.mjs';
import { fixture } from '../../router-logging/test/support.mjs';

const NOW = Date.parse('2026-11-15T20:00:00Z');
const iso = new Date(NOW).toISOString();
const emptyStall = () => ({ watch: {}, stalls: {}, ghosts: {}, lastStallScan: null });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stall-job-'));
  const previous = realIo.PATHS.dataDir;
  realIo.PATHS.dataDir = dir;
  t.after(() => { realIo.PATHS.dataDir = previous; rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  const io = {
    ...realIo, now: () => NOW,
    harnessCutoverStatus: async () => { calls.push('stall'); return { active: false, completed: false, claimedThreadIds: [], claimedRunIds: [] }; },
    activeSessions: async () => new Set(), activeThreads: async () => [],
    openDb: () => { calls.push('replica'); return { close() {} }; },
    assertReplicaFresh() {}, serverRuntime: () => null, openCodeRuntime: () => null,
    cancelledSubagentsSince: () => [], cancelledDelegatedTasksSince: () => [], restartRunsSince: () => [],
    failedRunsSince: () => [], failedSubagentsSince: () => [],
    telegram: () => assert.fail('unexpected notification'),
    interruptThread: () => assert.fail('unexpected interrupt'),
    ocInterrupt: () => assert.fail('unexpected interrupt'),
    sendToThread: () => assert.fail('unexpected send'),
  };
  return { dir, io, calls, read: name => JSON.parse(readFileSync(join(dir, name), 'utf8')) };
}

test('stall runs API-only, saves only its ledger, and scan never invokes it', async t => {
  const f = setup(t);
  await stall({}, f.io);
  assert.deepEqual(f.calls, ['stall']);
  assert.deepEqual(f.read('stall-state.json'), { ...emptyStall(), lastStallScan: iso });
  assert.deepEqual(readdirSync(f.dir), ['stall-state.json']);
  f.calls.length = 0;
  await scan({ maxAgeHours: 6 }, f.io);
  assert.ok(f.calls.includes('replica'));
  assert.ok(!f.calls.includes('stall'));
  assert.deepEqual(f.read('state.json'), { handled: {}, lastScan: iso, servers: [] });
  assert.deepEqual(f.read('stall-state.json'), { ...emptyStall(), lastStallScan: iso });
});

test('migration preserves all four keys through scan-first and stale-scan saves, once only', async t => {
  const f = setup(t);
  const legacy = {
    watch: { ses_a: { fp: 'waiting', since: NOW - 60_000 } },
    stalls: { pending: { ses: 'ses_a', threadId: 'a', at: iso, telegramTries: 1 } },
    ghosts: { a: { ses: 'ses_a', runId: 'run:a', since: NOW - 60_000 } }, lastStallScan: iso,
  };
  writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...legacy, handled: {}, lastScan: iso, servers: [] }));
  const staleScan = realIo.loadState();
  assert.deepEqual(staleScan, { handled: {}, lastScan: iso, servers: [] });
  await scan({ maxAgeHours: 6 }, f.io);
  assert.deepEqual(realIo.loadStallState(), legacy);
  assert.equal(existsSync(join(f.dir, 'stall-state.json')), false);
  // Even a failed first API pass must retain migrated records and retries.
  await assert.rejects(stall({}, { ...f.io, harnessCutoverStatus: async () => { throw Object.assign(new Error('API unavailable'), { code: 'TEST_CUTOVER_UNAVAILABLE' }); } }), /API unavailable/);
  assert.deepEqual(f.read('stall-state.json'), legacy);
  const fresh = structuredClone(legacy);
  fresh.stalls.pending.telegramTries = 2;
  fresh.lastStallScan = new Date(NOW + 60_000).toISOString();
  realIo.saveStallState(fresh, NOW);
  const before = readFileSync(join(f.dir, 'stall-state.json'), 'utf8');
  realIo.saveState({ ...staleScan, ...legacy }, NOW + 75 * 60_000);
  assert.equal(readFileSync(join(f.dir, 'stall-state.json'), 'utf8'), before);
  assert.deepEqual(f.read('state.json'), staleScan);
  // A still-running old release can write its entire old snapshot back.
  writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...staleScan, ...legacy }));
  assert.deepEqual(realIo.loadStallState(), fresh);
});

for (const held of ['scan', 'stall']) test(`${held}.lock cannot block the other job`, async t => {
  const f = setup(t);
  const release = realIo.acquireLock(NOW, held);
  t.after(release);
  assert.equal(realIo.acquireLock(NOW, held), null);
  if (held === 'scan') await stall({}, f.io);
  else await scan({ maxAgeHours: 6 }, f.io);
  assert.ok(existsSync(join(f.dir, `${held}.lock`)));
  assert.equal(existsSync(join(f.dir, `${held === 'scan' ? 'stall' : 'scan'}.lock`)), false);
  assert.ok(existsSync(join(f.dir, held === 'scan' ? 'stall-state.json' : 'state.json')));
});

test('a second stall process skips without reads or writes while its lock is held', async t => {
  const f = setup(t), release = realIo.acquireLock(NOW, 'stall');
  t.after(release);
  await stall({}, f.io);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readdirSync(f.dir), ['stall.lock']);
});

test('paused stall exits cleanly without actions or state writes, then resumes', async t => {
  const f = setup(t);
  await pauseRecovery(f.dir, {}, NOW);
  await stall({}, f.io);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(readdirSync(f.dir), ['control.json']);
  await resumeRecovery(f.dir, NOW + 60_000);
  f.io.now = () => NOW + 60_000;
  await stall({}, f.io);
  assert.deepEqual(f.calls, ['stall']);
});

test('stall dry-run performs API reads without publishing migration or changing either ledger', async t => {
  const f = setup(t);
  writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ ...emptyStall(), handled: {}, servers: [] }));
  const before = readFileSync(join(f.dir, 'state.json'), 'utf8');
  await stall({ dryRun: true, verbose: true }, f.io);
  assert.deepEqual(f.calls, ['stall']);
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(f.dir), ['state.json']);
});

test('stall.scan retains nested cause tags and failing API phase', async t => {
  const { rows } = fixture(t);
  const f = setup(t);
  const cause = Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
  await assert.rejects(stall({}, { ...f.io, activeSessions: async () => { throw new TypeError('fetch failed', { cause }); } }), /fetch failed/);
  const row = rows().find(r => r.name === 'stall.scan');
  assert.equal(row.ok, false);
  assert.equal(row.error.tag, 'ECONNRESET');
  assert.equal(row.props.phase, 'activeSessions');
  assert.equal(existsSync(join(f.dir, 'stall.lock')), false);
  assert.ok(existsSync(join(f.dir, 'stall-state.json')));
});

// Every interrupt route must publish its intent before a concurrent replica
// reader can observe the cancellation, including follow-up OpenCode retries.
for (const route of ['robob', 'opencode', 'ghost', 'fallback']) test(`${route} interrupt intent is durable while the stall pass is still running`, async t => {
  const f = setup(t), sessions = ['ses_a', 'ses_b', 'ses_c'];
  const tail = [{ type: 'assistant', time: { created: NOW - 60 * 60_000 }, content: [] }];
  const fp = fingerprint(tail);
  const threads = sessions.map(ses => ({ threadId: `thread:${ses}`, title: ses, nativeSessionId: ses,
    model: { instanceId: 'opencode' }, activeRunId: `run:${ses}`, state: 'running',
    parentThreadId: null, relationshipToParent: null, pendingRequests: [] }));
  const state = emptyStall();
  for (const thread of threads) {
    const ses = thread.nativeSessionId;
    state.watch[ses] = { fp, since: NOW - 60 * 60_000 };
    if (route === 'ghost') state.ghosts[thread.threadId] = { ses, runId: thread.activeRunId, since: NOW - 20 * 60_000 };
    if (route === 'fallback') state.stalls[ses] = { ses, threadId: thread.threadId, runId: thread.activeRunId,
      at: iso, action: 'robob', interruptedAt: NOW - 2 * 60_000, fp, errors: [], note: true };
  }
  realIo.saveStallState(state, NOW);
  const cancellations = [];
  let overlap;
  const interrupt = async ses => {
    const published = Object.values(f.read('stall-state.json').stalls).find(s => s.ses === ses);
    assert.ok(published, 'publish before sending interrupt');
    assert.ok(published.interruptedAt <= NOW);
    if (route === 'opencode' || route === 'fallback') assert.equal(published.ocTries, 1);
    cancellations.push({ subagent_id: `sub:${ses}`, thread_id: `parent:${ses}`, run_id: `run:${ses}`,
      provider_thread_id: `provider-thread:provider:opencode:provider-instance:opencode:native-thread:${ses}`,
      completed_at: iso, result: null });
    if (cancellations.length === sessions.length) {
      // Re-enter replica recovery before even the last interrupt returns.
      overlap = restartScan({ db: null, state: { handled: {}, servers: [] },
        now: NOW + 30_000, sinceIso: iso, floorMs: NOW - 3_600_000, log() {} }, {
        ...f.io, cancelledSubagentsSince: () => cancellations,
        subagentParent: () => assert.fail('stall cancellation escaped exclusion'),
      });
      await overlap;
    }
    return { result: 'interrupt_requested', runId: `run:${ses}` };
  };
  const active = route === 'ghost' ? new Set() : new Set(sessions);
  Object.assign(f.io, {
    activeSessions: async () => active,
    activeThreads: async () => route === 'ghost' ? threads : [],
    installerResumePendingMs: () => null,
    ocTail: async () => tail, ocSession: async ses => ({ id: ses }),
    ocForms: async () => [], ocPermissions: async () => [],
    threadByNative: async ses => route === 'opencode' ? null : threads.find(t => t.nativeSessionId === ses),
    getThread: async id => threads.find(t => t.threadId === id),
    ocInterrupt: interrupt,
    interruptThread: async id => interrupt(threads.find(t => t.threadId === id).nativeSessionId),
  });
  await stall({}, f.io);
  assert.equal(cancellations.length, 3);
  assert.ok(overlap);
  const result = await overlap;
  assert.equal(result.length, 0);
  assert.equal(result.runIds.size, 0);
  assert.equal(existsSync(join(f.dir, 'stall.lock')), false);
});

test('failure to publish interrupt intent prevents the interrupt', async t => {
  const f = setup(t);
  const tail = [{ type: 'assistant', time: { created: NOW - 3_600_000 }, content: [] }];
  realIo.saveStallState({ ...emptyStall(), watch: { ses_a: { fp: fingerprint(tail), since: NOW - 3_600_000 } } }, NOW);
  let interrupted = false;
  Object.assign(f.io, {
    activeSessions: async () => new Set(['ses_a']), ocTail: async () => tail,
    ocSession: async () => ({}), ocForms: async () => [], ocPermissions: async () => [],
    threadByNative: async () => null,
    saveStallState: () => { throw Object.assign(new Error('ledger unavailable'), { code: 'TEST_LEDGER_UNAVAILABLE' }); },
    ocInterrupt: async () => { interrupted = true; },
  });
  await assert.rejects(stall({}, f.io), /ledger unavailable/);
  assert.equal(interrupted, false);
  assert.equal(existsSync(join(f.dir, 'stall.lock')), false);
});
