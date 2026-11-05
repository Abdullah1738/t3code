import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallScan } from '../lib/stallwatch.mjs';
import { GHOST_RUN_MS, MAX_PER_DAY, ghostCandidates, observeGhosts, planGhost, buildStallNote } from '../lib/stall.mjs';

// Fixtures modelled on card #433: a running Robob thread whose OpenCode session stays idle.
const T0 = Date.parse('2026-10-29T19:37:39Z');
const MIN = 60_000;
const SES = 'ses_g';
const STALL_ID = `st-${SES}-20261029T193739Z`;
const ghostThread = (over = {}) => ({
  model: { instanceId: 'opencode' },
  threadId: 'thread:433', title: '#433 External PR', state: 'running', activeRunId: 'run:8',
  nativeSessionId: SES, pendingRequest: null, archived: false, origin: null, ...over,
});
const idleTail = (createdMs) => [{ type: 'assistant', time: { created: createdMs }, content: [] }];

function fakeIo({ threads = [ghostThread()], active = [], tails = { [SES]: idleTail(T0 - 20 * MIN) }, installerMs = null, interruptResult, failThreads = false, getThreads } = {}) {
  let liveThreads = threads;
  const calls = { interruptThread: [], sendToThread: [], telegram: [], unexpected: [] };
  const byId = () => getThreads ?? Object.fromEntries(liveThreads.map((t) => [t.threadId, t]));
  const io = {
    harnessCutoverStatus: async () => ({ active: false, completed: false, claimedThreadIds: [], claimedRunIds: [] }),
    activeSessions: async () => new Set(active),
    ocTail: async (ses) => tails[ses] ?? null,
    activeThreads: async () => {
      if (failThreads) throw new Error('control API down');
      return liveThreads;
    },
    getThread: async (id) => byId()[id] ?? null,
    interruptThread: async (threadId, opts) => {
      calls.interruptThread.push({ threadId, ...opts });
      const t = byId()[threadId];
      return interruptResult ?? { result: 'interrupt_requested', runId: t?.activeRunId };
    },
    sendToThread: async (threadId, text, opts) => { calls.sendToThread.push({ threadId, text, ...opts }); return { ok: true }; },
    telegram: (args) => { calls.telegram.push(args); },
    installerResumePendingMs: () => installerMs,
    ocSession: async () => { calls.unexpected.push('ocSession'); return null; },
    ocForms: async () => { calls.unexpected.push('ocForms'); return []; },
    ocPermissions: async () => { calls.unexpected.push('ocPermissions'); return []; },
    threadByNative: async () => { calls.unexpected.push('threadByNative'); return null; },
    ocChildren: async () => { calls.unexpected.push('ocChildren'); return []; },
    ocInterrupt: async () => { calls.unexpected.push('ocInterrupt'); return false; },
  };
  return {
    io, calls,
    setThreads(next) { liveThreads = next; },
  };
}

const freshState = () => ({ handled: {}, watch: {}, stalls: {}, servers: [], ghosts: {} });
const logs = () => { const lines = []; return { lines, log: (line) => lines.push(line) }; };

// ---------- pure helpers ----------

test('ghostCandidates keeps only a running ses_ thread with no pending request, not archived, not active in OpenCode', () => {
  const threads = [
    ghostThread(),
    ghostThread({ threadId: 'w', state: 'waiting' }),
    ghostThread({ threadId: 'q', state: 'queued' }),
    ghostThread({ threadId: 'n', nativeSessionId: null }),
    ghostThread({ threadId: 'x', nativeSessionId: 'thr_x' }),
    ghostThread({ threadId: 'p', pendingRequest: { id: 'r' } }),
    ghostThread({ threadId: 'a', archived: true }),
    ghostThread({ threadId: 'act', nativeSessionId: 'ses_busy' }),
  ];
  const got = ghostCandidates(threads, new Set(['ses_busy'])).map((t) => t.threadId);
  assert.deepEqual(got, ['thread:433']);
});

test('native threads and stale OpenCode aliases never become ghost candidates or receive old stall notes', async () => {
  for (const instanceId of ['claudeAgent', 'codex', 'codex-cu']) {
    const native = ghostThread({ model: { instanceId } });
    const fake = fakeIo({ threads: [native] });
    const state = freshState();
    state.ghosts[native.threadId] = { ses: SES, runId: 'run:8', since: T0 - 60 * MIN };
    state.stalls[STALL_ID] = { ses: SES, threadId: native.threadId, runId: 'run:old', interruptedAt: T0 - MIN,
      errors: [], note: true, fp: null, quietMs: 60 * MIN, quietSince: T0 - 60 * MIN, title: 'Old stall', label: 'waiting', action: 'robob' };
    await stallScan({ state, now: T0 + 60 * MIN, log: () => {} }, fake.io);
    assert.deepEqual(state.ghosts, {});
    assert.deepEqual(fake.calls.interruptThread, []);
    assert.deepEqual(fake.calls.sendToThread, []);
  }
});

test('cutover-owned OpenCode ghosts and interrupted stalls do not interrupt, fall back or resume', async () => {
  const fake = fakeIo();
  fake.io.harnessCutoverStatus = async () => ({ active: true, completed: false, claimedThreadIds: ['thread:433'] });
  const state = freshState();
  state.stalls[STALL_ID] = { ses: SES, threadId: 'thread:433', runId: 'run:8', interruptedAt: T0 - MIN, note: true };
  await stallScan({ state, now: T0, log: () => {} }, fake.io);
  await stallScan({ state, now: T0 + 60 * MIN, log: () => {} }, fake.io);
  assert.deepEqual(fake.calls.interruptThread, []);
  assert.deepEqual(fake.calls.sendToThread, []);
  assert.deepEqual(fake.calls.unexpected, []);
});

test('observeGhosts keeps since for the same run, resets it on a new run, drops threads no longer listed', () => {
  const first = observeGhosts({}, [ghostThread()], T0);
  assert.deepEqual(first['thread:433'], { runId: 'run:8', ses: SES, since: T0 });
  const same = observeGhosts(first, [ghostThread()], T0 + 5 * MIN);
  assert.equal(same['thread:433'].since, T0);
  const moved = observeGhosts(first, [ghostThread({ activeRunId: 'run:9' })], T0 + 5 * MIN);
  assert.equal(moved['thread:433'].since, T0 + 5 * MIN);
  assert.deepEqual(observeGhosts(first, [], T0 + 5 * MIN), {});
});

test('planGhost: plain threads act with a note, crw and iMessage threads without one, a day full of stalls only reports', () => {
  assert.deepEqual(planGhost({ thread: ghostThread() }).action, 'robob');
  assert.equal(planGhost({ thread: ghostThread() }).note, true);
  for (const origin of ['imessage', 'crw']) {
    const plan = planGhost({ thread: ghostThread({ origin }) });
    assert.equal(plan.action, 'robob');
    assert.equal(plan.note, false);
  }
  assert.equal(planGhost({ thread: ghostThread(), recent: MAX_PER_DAY }).action, 'report');
});

test('buildStallNote for a ghost says the turn never reached the session, with the quiet minutes', () => {
  const text = buildStallNote({ kind: 'ghost', quietSince: T0, quietMs: 16 * MIN, label: 'x' });
  assert.ok(text.startsWith('[stream-recovery] This thread hung: Robob showed a turn running since'));
  assert.match(text, /Robob showed a turn running/);
  assert.match(text, /16 min/);
});

// ---------- scan behaviour ----------

test('happy path: waits out the 15 min, interrupts once through Robob, sends one note after it clears', async () => {
  const fake = fakeIo();
  const state = freshState();
  const { lines, log } = logs();

  await stallScan({ state, now: T0, log }, fake.io);
  assert.equal(state.ghosts['thread:433'].since, T0);
  assert.equal(fake.calls.interruptThread.length, 0);

  const scan2 = T0 + GHOST_RUN_MS + MIN;
  await stallScan({ state, now: scan2, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);
  assert.equal(fake.calls.interruptThread[0].clientRequestId, STALL_ID);
  assert.equal(fake.calls.interruptThread[0].expectedRunId, 'run:8');
  const stall = state.stalls[STALL_ID];
  assert.equal(stall.kind, 'ghost');
  assert.equal(stall.action, 'robob');
  assert.equal(stall.note, true);
  assert.equal(stall.done, undefined);
  assert.ok(lines.some((l) => l.includes('ghost run')));

  // Robob moved on to a new run; OpenCode is still idle.
  fake.setThreads([ghostThread({ activeRunId: 'run:9', nativeSessionId: SES })]);
  fake.io.activeThreads = async () => [];
  await stallScan({ state, now: scan2 + MIN, log }, fake.io);
  assert.equal(fake.calls.sendToThread.length, 1);
  assert.equal(fake.calls.sendToThread[0].clientRequestId, `${STALL_ID}:note`);
  assert.match(fake.calls.sendToThread[0].text, /Robob showed a turn running/);
  assert.equal(state.stalls[STALL_ID].outcome, 'cleared');
  assert.equal(state.stalls[STALL_ID].done, true);
  assert.equal(fake.calls.telegram.length, 1);
  assert.equal(fake.calls.telegram[0].severity, 'info');
  assert.deepEqual(fake.calls.unexpected, []);

  await stallScan({ state, now: scan2 + 2 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);
  assert.equal(fake.calls.sendToThread.length, 1);
  assert.equal(fake.calls.telegram.length, 1);
  assert.deepEqual(fake.calls.unexpected, []);
});

test('a session that OpenCode lists as active is never interrupted as a ghost', async () => {
  const fake = fakeIo({ active: [SES], tails: { [SES]: idleTail(T0 - 60 * MIN) } });
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 0);
  assert.deepEqual(state.ghosts, {});
});

test('the installer resume pending blocks the interrupt until it clears', async () => {
  const fake = fakeIo({ installerMs: T0 });
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 0);

  fake.io.installerResumePendingMs = () => null;
  await stallScan({ state, now: T0 + 21 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);
  assert.deepEqual(fake.calls.unexpected, []);
});

test('a session whose newest message is under 15 min old is left alone', async () => {
  const fake = fakeIo({ tails: { [SES]: idleTail(T0 + 16 * MIN - 5 * MIN) } });
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 16 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 0);
});

test('an imessage thread is interrupted, cleared, and gets no carry-on note', async () => {
  const fake = fakeIo({ threads: [ghostThread({ origin: 'imessage' })] });
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);

  fake.setThreads([ghostThread({ origin: 'imessage', activeRunId: 'run:9' })]);
  fake.io.activeThreads = async () => [];
  await stallScan({ state, now: T0 + 21 * MIN, log }, fake.io);
  assert.equal(fake.calls.sendToThread.length, 0);
  assert.equal(fake.calls.telegram.length, 1);
  assert.equal(state.stalls[STALL_ID].outcome, 'cleared');
});

test('after 3 acted stalls on one session in 24h a new ghost is only reported', async () => {
  const fake = fakeIo();
  const state = freshState();
  const { log } = logs();
  for (let i = 0; i < MAX_PER_DAY; i++) {
    state.stalls[`old-${i}`] = {
      ses: SES, action: 'robob', at: new Date(T0 - (i + 1) * MIN).toISOString(), done: true, outcome: 'cleared',
    };
  }
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 0);
  const stall = state.stalls[STALL_ID];
  assert.equal(stall.outcome, 'report');
  assert.equal(stall.done, true);
  assert.equal(fake.calls.telegram.length, 1);
  assert.equal(fake.calls.telegram[0].severity, 'attention');
});

test('dry run never interrupts and writes no stall entry', async () => {
  const fake = fakeIo();
  const state = freshState();
  const { lines, log } = logs();
  await stallScan({ state, now: T0, dryRun: true, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, dryRun: true, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 0);
  assert.deepEqual(state.stalls, {});
  assert.ok(lines.some((l) => l.includes('(dry run)')));
});

test('a failing thread list does not break the normal scan and leaves ghost state as it was', async () => {
  const fake = fakeIo({ failThreads: true });
  const state = freshState();
  state.ghosts = { 'thread:433': { runId: 'run:8', ses: SES, since: T0 } };
  const before = JSON.stringify(state.ghosts);
  const { log } = logs();
  await assert.doesNotReject(stallScan({ state, now: T0 + 20 * MIN, log }, fake.io));
  assert.equal(JSON.stringify(state.ghosts), before);
  assert.equal(fake.calls.interruptThread.length, 0);
});

test('a no_active_run answer clears with no note: the next scan finishes it as cleared', async () => {
  const fake = fakeIo({ interruptResult: { result: 'no_active_run' } });
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);
  assert.equal(state.stalls[STALL_ID].runId, null);
  assert.equal(state.stalls[STALL_ID].note, false);

  fake.io.activeThreads = async () => [];
  await stallScan({ state, now: T0 + 21 * MIN, log }, fake.io);
  assert.equal(state.stalls[STALL_ID].outcome, 'cleared');
  assert.equal(fake.calls.sendToThread.length, 0);
  assert.deepEqual(fake.calls.unexpected, []);
});

test('a ghost is never interrupted directly in OpenCode, even when a newer run starts on the same session', async () => {
  const fake = fakeIo();
  const state = freshState();
  const { log } = logs();
  await stallScan({ state, now: T0, log }, fake.io);
  await stallScan({ state, now: T0 + 20 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);

  // Run 9 starts on the same session and OpenCode now shows it active, but its tail read fails.
  fake.setThreads([ghostThread({ activeRunId: 'run:9' })]);
  fake.io.activeThreads = async () => [ghostThread({ activeRunId: 'run:9' })];
  fake.io.activeSessions = async () => new Set([SES]);
  fake.io.ocTail = async () => { throw new Error('tail unavailable'); };
  await stallScan({ state, now: T0 + 40 * MIN, log }, fake.io);
  await stallScan({ state, now: T0 + 45 * MIN, log }, fake.io);
  assert.equal(fake.calls.interruptThread.length, 1);
  assert.deepEqual(fake.calls.unexpected, []);
  assert.equal(state.stalls[STALL_ID].ocTries, undefined);
});

test('a run that starts OpenCode-active during the tail read is not interrupted', async () => {
  let activeSet = new Set();
  let liveThreads = [ghostThread()];
  const calls = { interruptThread: [], unexpected: [] };
  const io = {
    harnessCutoverStatus: async () => ({ active: false, completed: false, claimedThreadIds: [], claimedRunIds: [] }),
    activeSessions: async () => new Set(activeSet),
    ocTail: async (ses) => {
      // Run 9 begins and OpenCode picks the session up while the tail is being read.
      liveThreads = [ghostThread({ activeRunId: 'run:9' })];
      activeSet = new Set([ses]);
      return idleTail(T0 - 60 * MIN);
    },
    activeThreads: async () => liveThreads,
    getThread: async () => liveThreads[0] ?? null,
    interruptThread: async (threadId, opts) => { calls.interruptThread.push({ threadId, ...opts }); return { result: 'interrupt_requested', runId: 'run:9' }; },
    sendToThread: async () => ({ ok: true }),
    telegram: () => {},
    installerResumePendingMs: () => null,
    ocSession: async () => { calls.unexpected.push('ocSession'); return null; },
    ocForms: async () => { calls.unexpected.push('ocForms'); return []; },
    ocPermissions: async () => { calls.unexpected.push('ocPermissions'); return []; },
    threadByNative: async () => { calls.unexpected.push('threadByNative'); return null; },
    ocChildren: async () => { calls.unexpected.push('ocChildren'); return []; },
    ocInterrupt: async () => { calls.unexpected.push('ocInterrupt'); return false; },
  };
  const state = freshState();
  const { log } = logs();
  // Get the ghost past its 15 min window: the first scan only records `since`.
  await stallScan({ state, now: T0, log }, io);
  activeSet = new Set();
  liveThreads = [ghostThread()];
  // Scan 2 reads the tail, which flips run 9 to OpenCode-active; the re-check must skip it.
  await stallScan({ state, now: T0 + 20 * MIN, log }, io);
  assert.equal(calls.interruptThread.length, 0);
  assert.deepEqual(calls.unexpected, []);
  assert.equal(state.ghosts['thread:433'], undefined);
});
