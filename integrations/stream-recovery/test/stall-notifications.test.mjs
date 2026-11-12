import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS, loadState, saveState } from '../lib/io.mjs';
import { fingerprint, stallId } from '../lib/stall.mjs';
import { stallScan } from '../lib/stallwatch.mjs';

const T0 = Date.parse('2026-11-01T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const tail = [{ type: 'assistant', time: { created: T0 - 2 * HOUR }, content: [] }];
const freshState = () => ({ handled: {}, watch: {}, stalls: {}, ghosts: {}, servers: [] });
const thread = (id, ses, extra = {}) => ({
  threadId: id, nativeSessionId: ses, activeRunId: `run:${ses}`, title: id,
  parentThreadId: null, relationshipToParent: null, pendingRequests: [],
  archived: false, origin: null, ...extra,
});
const record = (ses, owner, at, extra = {}) => ({
  ses, threadId: owner, at: new Date(at).toISOString(), doneAt: new Date(at + MIN).toISOString(),
  quietSince: at - 30 * MIN, quietMs: 30 * MIN, label: 'waiting on the model',
  title: ses, kind: 'llm', action: 'robob', outcome: 'cleared', done: true,
  errors: [], ...extra,
});

function harness({ active = [], threads = {}, mappings = {}, sessions = {}, live = [] } = {}) {
  const calls = { interrupt: [], oc: [], note: [], telegram: [], order: [] };
  let failures = 0;
  const io = {
    activeSessions: async () => new Set(active),
    activeThreads: async () => live,
    ocTail: async () => tail,
    ocSession: async (ses) => sessions[ses] ?? { id: ses },
    ocForms: async () => [], ocPermissions: async () => [], ocChildren: async () => [],
    threadByNative: async (ses) => mappings[ses] ?? Object.values(threads).find((t) => t.nativeSessionId === ses) ?? null,
    getThread: async (id) => threads[id] ?? null,
    interruptThread: async (id, opts) => {
      calls.order.push(`robob:${id}`);
      calls.interrupt.push({ id, ...opts });
      return { result: 'interrupt_requested', runId: threads[id]?.activeRunId };
    },
    ocInterrupt: async (ses) => { calls.order.push(`oc:${ses}`); calls.oc.push(ses); return true; },
    sendToThread: async (id, text, opts) => { calls.note.push({ id, text, ...opts }); },
    telegram: (args) => {
      calls.telegram.push(args);
      if (failures-- > 0) throw new Error('offline');
    },
    installerResumePendingMs: () => null,
  };
  return {
    io, calls, threads,
    active(next) { active = next; },
    live(next) { live = next; },
    failTelegram(count) { failures = count; },
  };
}

const scan = (state, fake, now, extra = {}) => stallScan({ state, now, log: () => {}, ...extra }, fake.io);
const watch = (state, ses, since = T0 - 30 * MIN) => {
  state.watch[ses] = { fp: fingerprint(tail), since };
  return stallId(ses, since);
};

test('first stall is recovered and persisted silently; a distinct later stall of the same thread alerts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-gate-'));
  const previousDir = PATHS.dataDir;
  PATHS.dataDir = dir;
  try {
    const a = thread('thread:A', 'ses_a');
    const fake = harness({ active: ['ses_a'], threads: { 'thread:A': a } });
    let state = freshState();
    const first = watch(state, 'ses_a');
    await scan(state, fake, T0);
    assert.deepEqual(fake.calls.interrupt, [{ id: 'thread:A', clientRequestId: first, reason: 'stall watch: waiting on the model' }]);
    fake.active([]);
    a.activeRunId = null;
    await scan(state, fake, T0 + MIN);
    assert.equal(fake.calls.note.length, 1);
    assert.equal(fake.calls.telegram.length, 0);
    assert.equal(state.stalls[first].alertEligible, false);
    saveState(state, T0 + MIN);
    state = loadState();
    a.nativeSessionId = 'ses_b';
    a.activeRunId = 'run:ses_b';
    const second = watch(state, 'ses_b', T0 - 29 * MIN);
    fake.active(['ses_b']);
    await scan(state, fake, T0 + 2 * MIN);
    fake.active([]);
    a.activeRunId = null;
    await scan(state, fake, T0 + 3 * MIN);
    assert.equal(fake.calls.interrupt.length, 2);
    assert.equal(fake.calls.note.length, 2);
    assert.equal(fake.calls.telegram.length, 1);
    assert.equal(fake.calls.telegram[0].key, `stream-recovery:${second}`);
    assert.equal(fake.calls.telegram[0].severity, 'info');
    await scan(state, fake, T0 + 4 * MIN);
    assert.equal(fake.calls.telegram.length, 1);
  } finally {
    PATHS.dataDir = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one-hour detection window is inclusive, excludes future records and other threads, and ignores insertion order', async () => {
  for (const [age, priorOwner, expected] of [
    [HOUR, 'thread:A', 1], [HOUR + 1, 'thread:A', 0],
    [MIN, 'thread:B', 0], [-MIN, 'thread:A', 0],
  ]) {
    const a = thread('thread:A', 'ses_current');
    const b = thread('thread:B', 'ses_prior');
    const fake = harness({ threads: { 'thread:A': a, 'thread:B': b } });
    const state = freshState();
    state.stalls.current = record('ses_current', 'thread:A', T0, { alertPending: true });
    state.stalls.excluded = record('ses_excluded', 'thread:A', T0 - MIN, { excluded: true, alertOwnerId: 'thread:A' });
    state.stalls.prior = record('ses_prior', priorOwner, T0 - age, { telegram: true });
    await scan(state, fake, T0 + 2 * MIN);
    assert.equal(fake.calls.telegram.length, expected, `age=${age}, prior=${priorOwner}`);
  }
});

test('same stall is not counted twice; simultaneous distinct stalls use detection order', async () => {
  const a = thread('thread:A', 'ses_a');
  const fake = harness({ threads: { 'thread:A': a } });
  const state = freshState();
  state.stalls.duplicate = record('ses_a', 'thread:A', T0 - MIN, { quietSince: T0 - 30 * MIN, runId: 'run:a', telegram: true });
  state.stalls.same = record('ses_a', 'thread:A', T0, { quietSince: T0 - 30 * MIN, runId: 'run:a', alertPending: true });
  await scan(state, fake, T0 + 2 * MIN);
  assert.equal(fake.calls.telegram.length, 0);
  state.stalls.first = record('ses_b', 'thread:A', T0 + 3 * MIN, { alertPending: true });
  state.stalls.second = record('ses_c', 'thread:A', T0 + 3 * MIN, { alertPending: true });
  // These simultaneous records have a genuinely earlier matching stall.
  await scan(state, fake, T0 + 4 * MIN);
  assert.deepEqual(fake.calls.telegram.map((x) => x.key), ['stream-recovery:first', 'stream-recovery:second']);

  const tied = freshState();
  tied.stalls.first = record('ses_x', 'thread:A', T0, { alertPending: true });
  tied.stalls.second = record('ses_y', 'thread:A', T0, { alertPending: true });
  const other = harness({ threads: { 'thread:A': a } });
  await scan(tied, other, T0 + MIN);
  assert.deepEqual(other.calls.telegram.map((x) => x.key), ['stream-recovery:second']);
});

test('same session with a different known run is distinct even at the same quiet time', async () => {
  const a = thread('thread:A', 'ses_a');
  const fake = harness({ threads: { 'thread:A': a } });
  const state = freshState();
  state.stalls.first = record('ses_a', 'thread:A', T0 - MIN, { runId: 'run:one', telegram: true });
  state.stalls.second = record('ses_a', 'thread:A', T0, {
    quietSince: state.stalls.first.quietSince, runId: 'run:two', alertPending: true,
  });
  await scan(state, fake, T0 + MIN);
  assert.deepEqual(fake.calls.telegram.map((x) => x.key), ['stream-recovery:second']);
});

test('ghost and active stalls count together without changing ghost recovery', async () => {
  const a = thread('thread:A', 'ses_ghost', { state: 'running', pendingRequest: null });
  const fake = harness({ threads: { 'thread:A': a }, live: [a] });
  const state = freshState();
  state.stalls.active = record('ses_old', 'thread:A', T0 - MIN, { alertOwnerId: 'thread:A', telegram: true });
  state.ghosts['thread:A'] = { runId: a.activeRunId, ses: 'ses_ghost', since: T0 - 20 * MIN };
  const id = stallId('ses_ghost', T0 - 20 * MIN);
  await scan(state, fake, T0);
  assert.equal(fake.calls.interrupt.length, 1);
  assert.equal(state.stalls[id].kind, 'ghost');
  fake.live([]);
  a.activeRunId = null;
  await scan(state, fake, T0 + MIN);
  assert.equal(fake.calls.note.length, 1);
  assert.equal(fake.calls.telegram[0].key, `stream-recovery:${id}`);
});

test('failed Telegram sends retry three times with the same key across reloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-retry-'));
  const previousDir = PATHS.dataDir;
  PATHS.dataDir = dir;
  try {
    const a = thread('thread:A', 'ses_b');
    const fake = harness({ threads: { 'thread:A': a } });
    fake.failTelegram(2);
    let state = freshState();
    state.stalls.prior = record('ses_a', 'thread:A', T0 - MIN, { alertOwnerId: 'thread:A', telegram: true });
    state.stalls.current = record('ses_b', 'thread:A', T0, { alertOwnerId: 'thread:A', alertPending: true });
    for (let i = 0; i < 4; i++) {
      await scan(state, fake, T0 + (i + 1) * MIN);
      saveState(state, T0 + (i + 1) * MIN);
      state = loadState();
    }
    assert.equal(fake.calls.telegram.length, 3);
    assert.deepEqual(new Set(fake.calls.telegram.map((x) => x.key)), new Set(['stream-recovery:current']));
    assert.equal(state.stalls.current.telegram, true);
    assert.equal(state.stalls.current.telegramTries, 3);
  } finally {
    PATHS.dataDir = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-upgrade failed sends are gated using persisted records, not retried as first stalls', async () => {
  const a = thread('thread:A', 'ses_new');
  const fake = harness({ threads: { 'thread:A': a } });
  const state = freshState();
  state.stalls.first = record('ses_old', 'thread:A', T0 - MIN, { telegram: false, telegramTries: 1 });
  state.stalls.second = record('ses_new', 'thread:A', T0, { telegram: false, telegramTries: 1 });
  await scan(state, fake, T0 + MIN);
  assert.deepEqual(fake.calls.telegram.map((x) => x.key), ['stream-recovery:second']);
  assert.equal(state.stalls.first.alertEligible, false);
  assert.equal(state.stalls.second.telegramTries, 2);
});

test('no control mapping does not block OpenCode recovery or invent an owner', async () => {
  const fake = harness({ active: ['ses_orphan'] });
  const state = freshState();
  state.stalls.prior = record('ses_older', null, T0 - MIN, { telegram: true });
  const id = watch(state, 'ses_orphan');
  await scan(state, fake, T0);
  assert.deepEqual(fake.calls.oc, ['ses_orphan']);
  fake.active([]);
  await scan(state, fake, T0 + MIN);
  assert.equal(state.stalls[id].alertPending, true);
  assert.equal(fake.calls.telegram.length, 0);
  await scan(state, fake, T0 + 7 * MIN);
  assert.equal(state.stalls[id].alertEligible, false);
  assert.equal(fake.calls.telegram.length, 0);
});

test('an unresolved earlier record defers instead of becoming fabricated evidence', async () => {
  const a = thread('thread:A', 'ses_current');
  const fake = harness({ threads: { 'thread:A': a } });
  const state = freshState();
  state.stalls.unknown = record('ses_unknown', null, T0 - MIN, { telegram: true });
  state.stalls.current = record('ses_current', 'thread:A', T0, { alertPending: true });
  await scan(state, fake, T0 + 2 * MIN);
  assert.equal(state.stalls.current.alertPending, true);
  assert.equal(fake.calls.telegram.length, 0);
  fake.io.threadByNative = async (ses) => ses === 'ses_unknown' ? a : null;
  await scan(state, fake, T0 + 3 * MIN);
  assert.deepEqual(fake.calls.telegram.map((x) => x.key), ['stream-recovery:current']);
});

test('mapped and unmapped native children recover before bounded owner lookup, then correlate to their owner', async () => {
  const root = thread('thread:A', 'ses_root');
  const child = thread('thread:provider:child', 'ses_child', { parentThreadId: 'thread:A', relationshipToParent: 'subagent' });
  const fake = harness({
    active: ['ses_child', 'ses_unmapped'], threads: { 'thread:A': root, 'thread:provider:child': child },
    sessions: { ses_child: { parentID: 'ses_root' }, ses_unmapped: { parentID: 'ses_root' } },
  });
  const state = freshState();
  const childId = watch(state, 'ses_child');
  const otherId = watch(state, 'ses_unmapped');
  const byNative = fake.io.threadByNative;
  fake.io.threadByNative = async (ses) => {
    if (ses === 'ses_root') assert.deepEqual(fake.calls.oc, ['ses_child', 'ses_unmapped']);
    return byNative(ses);
  };
  await scan(state, fake, T0);
  assert.deepEqual(fake.calls.oc, ['ses_child', 'ses_unmapped']);
  assert.equal(state.stalls[childId].alertOwnerId, 'thread:A');
  assert.equal(state.stalls[otherId].alertOwnerId, 'thread:A');
  fake.active([]);
  await scan(state, fake, T0 + MIN);
  assert.deepEqual(fake.calls.telegram.map((x) => x.key), [`stream-recovery:${otherId}`]);
});

test('a fork is its own owner rather than its parent', async () => {
  const root = thread('thread:root', 'ses_root');
  const fork = thread('thread:fork', 'ses_fork', { parentThreadId: 'thread:root', relationshipToParent: 'fork' });
  const fake = harness({ threads: { 'thread:root': root, 'thread:fork': fork } });
  const state = freshState();
  state.stalls.root = record('ses_root', 'thread:root', T0 - MIN, { telegram: true });
  state.stalls.fork = record('ses_fork', 'thread:fork', T0, { alertPending: true });
  await scan(state, fake, T0 + MIN);
  assert.equal(state.stalls.fork.alertEligible, false);
  assert.equal(fake.calls.telegram.length, 0);
});

test('a hung correlation lookup cannot prevent any recovery in the scan', async () => {
  const fake = harness({ active: ['ses_first', 'ses_second'], sessions: { ses_first: { parentID: 'ses_parent' } } });
  const state = freshState();
  watch(state, 'ses_first');
  watch(state, 'ses_second');
  const byNative = fake.io.threadByNative;
  fake.io.threadByNative = async (ses) => {
    if (ses === 'ses_parent') {
      assert.deepEqual(fake.calls.oc, ['ses_first', 'ses_second']);
      return new Promise(() => {});
    }
    return byNative(ses);
  };
  await scan(state, fake, T0);
  assert.deepEqual(fake.calls.oc, ['ses_first', 'ses_second']);
});

test('failed Robob read still performs the existing delayed OpenCode fallback', async () => {
  const a = thread('thread:A', 'ses_a');
  const fake = harness({ active: ['ses_a'], threads: { 'thread:A': a } });
  const state = freshState();
  watch(state, 'ses_a');
  await scan(state, fake, T0);
  fake.io.getThread = async () => { throw new Error('control offline'); };
  await scan(state, fake, T0 + 3 * MIN);
  assert.deepEqual(fake.calls.oc, ['ses_a']);
});

test('an uncertain Robob interrupt response still permits the existing OpenCode fallback', async () => {
  const a = thread('thread:A', 'ses_a');
  const fake = harness({ active: ['ses_a'], threads: { 'thread:A': a } });
  fake.io.interruptThread = async (id, opts) => {
    fake.calls.interrupt.push({ id, ...opts });
    throw new Error('response lost');
  };
  const state = freshState();
  const id = watch(state, 'ses_a');
  await scan(state, fake, T0);
  assert.equal(fake.calls.interrupt.length, 1);
  assert.match(state.stalls[id].errors[0], /response lost/);
  await scan(state, fake, T0 + 3 * MIN);
  assert.deepEqual(fake.calls.oc, ['ses_a']);
});

test('an old session is interrupted in OpenCode, not the thread current run', async () => {
  const a = thread('thread:A', 'ses_current');
  const fake = harness({ active: ['ses_old'], threads: { 'thread:A': a }, mappings: { ses_old: a } });
  const state = freshState();
  const id = watch(state, 'ses_old');
  await scan(state, fake, T0);
  assert.deepEqual(fake.calls.oc, ['ses_old']);
  assert.equal(fake.calls.interrupt.length, 0);
  assert.equal(state.stalls[id].threadId, null);
  assert.equal(state.stalls[id].alertOwnerId, 'thread:A');
});

test('no active run keeps the existing immediate OpenCode fallback', async () => {
  const a = thread('thread:A', 'ses_a', { activeRunId: null });
  const fake = harness({ active: ['ses_a'], threads: { 'thread:A': a } });
  fake.io.interruptThread = async (id, opts) => { fake.calls.interrupt.push({ id, ...opts }); return { result: 'no_active_run' }; };
  const state = freshState();
  const id = watch(state, 'ses_a');
  await scan(state, fake, T0);
  assert.equal(fake.calls.interrupt.length, 1);
  assert.deepEqual(fake.calls.oc, ['ses_a']);
  assert.equal(state.stalls[id].runId, null);
  assert.equal(state.stalls[id].note, false);
});

test('dry run does not finish a stored stall or consume an eligible retry', async () => {
  const a = thread('thread:A', 'ses_b');
  const fake = harness({ threads: { 'thread:A': a } });
  const state = freshState();
  state.stalls.prior = record('ses_a', 'thread:A', T0 - MIN, { alertOwnerId: 'thread:A', telegram: true });
  state.stalls.current = record('ses_b', 'thread:A', T0, {
    done: false, doneAt: undefined, runId: null, interruptedAt: T0, fp: 'old', note: false, alertOwnerId: 'thread:A',
  });
  const before = structuredClone(state.stalls);
  const lines = [];
  await stallScan({ state, now: T0 + MIN, dryRun: true, log: (line) => lines.push(line) }, fake.io);
  assert.deepEqual(state.stalls, before);
  assert.equal(fake.calls.telegram.length, 0);
  assert.ok(lines.some((line) => line.startsWith('summary (info):')));
  await scan(state, fake, T0 + 2 * MIN);
  assert.equal(fake.calls.telegram.length, 1);
});
