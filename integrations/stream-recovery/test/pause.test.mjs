import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadControl, pauseRecovery, resumeRecovery, controlStatus, parseDuration, recoveryElapsed, recoveryFloor, guardRecoveryIo } from '../lib/pause.mjs';
import { restartScan } from '../lib/restartwatch.mjs';
import { stallScan } from '../lib/stallwatch.mjs';
import { FALLBACK_MS } from '../lib/stall.mjs';
import { act, gatherThread, scan } from '../cli.mjs';
import * as realIo from '../lib/io.mjs';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const temporary = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'stream-pause-')); temporary.push(dir); return dir; };
after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function command(dir, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, STREAM_RECOVERY_DATA: dir } });
}
const stateOf = () => ({ handled: {}, watch: {}, stalls: {}, servers: [], ghosts: {}, lastScan: null });
const cutover = async () => ({ active: false, completed: false, claimedThreadIds: [], claimedRunIds: [] });

test('default unpaused; CLI pause survives process restart, stale state save and idempotent resume', () => {
  const dir = temp();
  let r = command(dir, 'status', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { paused: false, until: null, reason: null, pendingIncidents: 0, pendingThreads: 0, lastSuccessfulScan: null });
  r = command(dir, 'pause', '--reason', 'maintenance', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).reason, 'maintenance');
  // An in-flight watcher owns only state.json, never control.json.
  writeFileSync(join(dir, 'state.json'), JSON.stringify(stateOf()));
  r = command(dir, 'status', '--json');
  assert.equal(JSON.parse(r.stdout).paused, true);
  assert.equal(JSON.parse(r.stdout).until, null);
  assert.equal(statSync(join(dir, 'control.json')).mode & 0o777, 0o600);
  assert.match(command(dir, 'status').stdout, /paused indefinitely/);
  for (let i = 0; i < 2; i++) {
    r = command(dir, 'resume', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).paused, false);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'))), stateOf());
  assert.equal(loadControl(dir).intervals.length, 1);
});

test('duration input class has explicit units, positive integral milliseconds and a valid date', () => {
  for (const [text, ms] of [['1ms', 1], ['1s', 1000], ['0.5m', 30_000], ['30m', 30 * MIN], ['2h', 120 * MIN], ['1d', 1440 * MIN]]) assert.equal(parseDuration(text), ms);
  for (const text of [undefined, '', '0', '0s', '-1m', '1', 'NaN', 'Infinityh', '1e3s', '1w', '1m junk', ' 1m', '1m ', '0.0001ms', '9999999999999999999d']) assert.throws(() => parseDuration(text), /bad --for/);
  const dir = temp();
  for (const args of [['pause', '--for'], ['pause', '--reason'], ['pause', '--reason', '--json'], ['pause', '--for', '-1h'], ['pause', '--for', '0m'], ['pause', '--for', '9000000000000000ms'], ['resume', '--for', '1m']]) assert.notEqual(command(dir, ...args).status, 0);
  assert.equal(controlStatus(loadControl(dir)).paused, false);
});

test('explicit expiry, repeated pause and resume preserve time excluded from deadlines and lookback', async () => {
  const dir = temp();
  await pauseRecovery(dir, { durationMs: 60 * MIN }, T0 + MIN);
  assert.equal(controlStatus(loadControl(dir), T0 + 60 * MIN).paused, true);
  assert.equal(controlStatus(loadControl(dir), T0 + 61 * MIN).paused, false);
  await pauseRecovery(dir, {}, T0 + 62 * MIN);
  await pauseRecovery(dir, { durationMs: 10 * MIN }, T0 + 63 * MIN);
  await resumeRecovery(dir, T0 + 65 * MIN);
  const io = { readControl: () => loadControl(dir) };
  assert.equal(recoveryElapsed(io, T0, T0 + 70 * MIN), 7 * MIN);
  assert.equal(recoveryFloor(io, T0 + 70 * MIN, 7 * MIN), T0);
  // The pause began before the ordinary discovery floor.
  assert.equal(recoveryFloor(io, T0 + 61 * MIN, 6 * MIN), T0 - 5 * MIN);
});

test('status JSON counts only pending work and exposes no ledger contents or credentials', () => {
  const dir = temp();
  const state = stateOf();
  state.lastScan = iso(T0);
  state.handled = { pending: { threads: { a: {}, b: {}, c: { done: true } }, incident: { runs: [{ thread_id: 'a' }, { thread_id: 'c' }] }, note: 'PRIVATE-NOTE' }, done: { done: true, threads: { c: {} } } };
  state.stalls = { pending: { threadId: 'b', note: 'PRIVATE-TOKEN' }, done: { done: true, threadId: 'd' } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const result = command(dir, 'status', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { paused: false, until: null, reason: null, pendingIncidents: 2, pendingThreads: 2, lastSuccessfulScan: iso(T0) });
  assert.doesNotMatch(result.stdout, /PRIVATE|"threads"|"native"|"token"|"note"/i);
});

function fixture(dir, { count = 1, busy = false, held = false, subs = [] } = {}) {
  const calls = [];
  let clock = T0 + 2 * MIN;
  const threads = Object.fromEntries(Array.from({ length: count }, (_, n) => {
    const id = `t${n}`;
    return [id, { threadId: id, title: id, model: { instanceId: 'opencode' }, nativeSessionId: `ses_${id}`, latestRunId: `cut-${id}`, ...(busy ? { activeRunId: 'new-run', status: 'running' } : {}) }];
  }));
  const runs = Object.keys(threads).map((id) => ({ instance_id: 'opencode', run_id: `cut-${id}`, thread_id: id, status: 'cancelled', ordinal: 1,
    requested_at: iso(T0 - MIN), started_at: iso(T0 - MIN), completed_at: iso(T0) }));
  const io = {
    now: () => clock, readControl: () => loadControl(dir), harnessCutoverStatus: cutover,
    OC_URL: 'http://fixture', assertReplicaFresh() {}, assertThreadInReplica() {},
    serverRuntime: () => ({ pid: 1, readyMs: T0 + 1000, procStartMs: T0 - MIN }), openCodeRuntime: () => null,
    restartRunsSince: () => runs, cancelledSubagentsSince: () => [], cancelledDelegatedTasksSince: () => subs,
    childNativeSession: () => null, childRunOutcomeSince: () => null, delegatedStoppedSince: () => false,
    runMessages: () => [], subagentParent: () => null, threadRoot: () => null,
    restartNoteRun: () => null, stoppedSince: () => false, runStartedSince: () => true,
    queuedRuns: () => held ? [{ run_id: 'held', held: true, requested_at: iso(T0), user_message_id: 'owner' }] : [], messageText: () => 'owner message',
    activeSessions: async () => new Set(), getThread: async (id) => threads[id] ?? null, robobHealthy: async () => true,
    saveState() {}, sendToThread: async (id) => { calls.push(['note', id]); }, dispatchCommand: async (cmd) => { calls.push([cmd.type, cmd.threadId]); },
    telegram: () => { calls.push(['telegram']); },
  };
  return { io, calls, threads, runs, setClock: (now) => { clock = now; }, args: (state) => ({ db: null, state, now: clock, sinceIso: iso(T0 - MIN), floorMs: recoveryFloor(io, clock, 6 * 3600_000), log() {} }) };
}

test('paused scan, restart, stall and stream-drop entry points remain silent without changing ledger', async () => {
  const dir = temp();
  await pauseRecovery(dir, {}, T0);
  const f = fixture(dir), state = stateOf(), before = structuredClone(state);
  await assert.rejects(restartScan(f.args(state), f.io), { code: 'RECOVERY_PAUSED' });
  await assert.rejects(stallScan({ state, now: T0, log() {} }, f.io), { code: 'RECOVERY_PAUSED' });
  await assert.rejects(act({ g: {}, incident: {} }, f.io), { code: 'RECOVERY_PAUSED' });
  await scan({}, { ...f.io, loadState: () => state, acquireLock: () => () => {} });
  assert.deepEqual(state, before);
  assert.deepEqual(f.calls, []);
});

test('every mutation gate re-reads control after the preceding mutation', async () => {
  for (const method of ['sendToThread', 'dispatchCommand', 'interruptThread', 'ocInterrupt', 'telegram']) {
    const dir = temp(), calls = [];
    const io = guardRecoveryIo({ readControl: () => loadControl(dir), now: () => T0, [method]: () => calls.push(method) });
    io[method]();
    await pauseRecovery(dir, {}, T0);
    assert.throws(() => io[method](), { code: 'RECOVERY_PAUSED' });
    assert.deepEqual(calls, [method]);
  }
});

test('pause during first restart note prevents second send; sent note reconciles once after resume', async () => {
  const dir = temp(), f = fixture(dir, { count: 2, held: true }), state = stateOf();
  const send = f.io.sendToThread;
  f.io.sendToThread = async (...args) => { await send(...args); await pauseRecovery(dir, {}, T0 + 2 * MIN); };
  await assert.rejects(restartScan(f.args(state), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, [['note', 't0']]);
  const entry = Object.values(state.handled)[0];
  assert.equal(entry.threads.t0.noteSent, true);
  assert.equal(entry.threads.t0.failures, undefined);
  assert.ok(!entry.done);
  assert.ok(!entry.threads.t0.done);
  await resumeRecovery(dir, T0 + 62 * MIN);
  f.setClock(T0 + 62 * MIN);
  f.io.sendToThread = send;
  await restartScan(f.args(state), f.io);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'note'), [['note', 't0'], ['note', 't1']]);
  assert.equal(f.calls.filter(([kind]) => kind === 'queue.resume').length, 2);
});

test('a >30 minute pause cannot expire a busy pending restart or its failure budget', async () => {
  const dir = temp(), f = fixture(dir, { busy: true }), state = stateOf();
  await restartScan(f.args(state), f.io);
  await pauseRecovery(dir, {}, T0 + 2 * MIN);
  f.setClock(T0 + 62 * MIN);
  await assert.rejects(restartScan(f.args(state), f.io), { code: 'RECOVERY_PAUSED' });
  await resumeRecovery(dir, T0 + 62 * MIN);
  await restartScan(f.args(state), f.io);
  const entry = Object.values(state.handled)[0];
  assert.ok(!entry.threads.t0.done);
  assert.equal(entry.threads.t0.failures, undefined);
  Object.assign(f.threads.t0, { activeRunId: null, status: 'idle' });
  await restartScan(f.args(state), f.io);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'note'), [['note', 't0']]);
});

test('pause between stream-drop queue mutations blocks remaining cancels, resume and note', async () => {
  const dir = temp(), f = fixture(dir);
  const thread = f.threads.t0;
  const g = { thread, sourceRuns: [], plan: { threadId: 't0', action: 'note', resumeQueue: true }, lost: [], reply: null, forms: [], orphans: [],
    held: [{ run_id: 'owner' }], staleHeld: [{ run_id: 'pulse1' }, { run_id: 'pulse2' }] };
  f.io.dispatchCommand = async (cmd) => { f.calls.push([cmd.type]); await pauseRecovery(dir, {}, T0 + 2 * MIN); };
  await assert.rejects(act({ incident: { id: 'incident' }, g }, f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, [['queued-run.cancel']]);
});

test('corrupt control fails closed for status and all mutation gates', () => {
  const dir = temp();
  writeFileSync(join(dir, 'control.json'), '{}');
  assert.notEqual(command(dir, 'status', '--json').status, 0);
  assert.throws(() => guardRecoveryIo({ readControl: () => loadControl(dir), telegram: () => assert.fail('sent') }).telegram(), { code: 'RECOVERY_PAUSED' });
});

test('real transport mutation entry points reject pause before credentials or network access', async () => {
  const dir = temp(), original = realIo.PATHS.dataDir;
  realIo.PATHS.dataDir = dir;
  try {
    await pauseRecovery(dir);
    for (const fn of [() => realIo.sendToThread('fixture', 'body'), () => realIo.interruptThread('fixture'),
      () => realIo.ocInterrupt('ses_fixture'), () => realIo.dispatchCommand({ type: 'queue.resume' })]) {
      await assert.rejects(async () => fn(), { code: 'RECOVERY_PAUSED' });
    }
    assert.throws(() => realIo.telegram({ text: 'fixture' }), { code: 'RECOVERY_PAUSED' });
  } finally { realIo.PATHS.dataDir = original; }
});

function stallFixture(dir) {
  const state = stateOf(), calls = [];
  let now = T0;
  let active = new Set(['ses_a', 'ses_b']);
  let thread = { threadId: 't', title: 'Thread', model: { instanceId: 'opencode' }, nativeSessionId: 'ses_a', activeRunId: 'run', state: 'running' };
  const io = { readControl: () => loadControl(dir), now: () => now, harnessCutoverStatus: cutover,
    activeSessions: async () => active,
    ocTail: async () => [{ type: 'assistant', time: { created: T0 }, content: [] }],
    ocSession: async () => ({ title: 'Session' }), ocForms: async () => [], ocPermissions: async () => [],
    threadByNative: async () => null, activeThreads: async () => [], getThread: async () => thread,
    installerResumePendingMs: () => null,
    ocInterrupt: async (ses) => { calls.push(['oc', ses]); return true; },
    interruptThread: async () => { calls.push(['robob']); return { result: 'interrupt_requested', runId: 'run' }; },
    sendToThread: async () => { calls.push(['note']); }, telegram: () => { calls.push(['telegram']); },
  };
  return { state, calls, io, setTime(ms) { now = ms; }, clear() { active = new Set(); thread = { ...thread, activeRunId: null, state: 'idle' }; },
    args: () => ({ state, now, log() {} }) };
}

test('pause after an OpenCode interrupt stops the next session without consuming a stall attempt', async () => {
  const dir = temp(), f = stallFixture(dir);
  await stallScan(f.args(), f.io);
  f.setTime(T0 + 31 * MIN);
  f.io.ocInterrupt = async (ses) => { f.calls.push(['oc', ses]); await pauseRecovery(dir, {}, T0 + 31 * MIN); return true; };
  await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, [['oc', 'ses_a']]);
  assert.equal(Object.values(f.state.stalls).length, 1);
  assert.equal(Object.values(f.state.stalls)[0].ocTries, 1);
  assert.ok(!Object.values(f.state.stalls)[0].done);
});

test('pause after a Robob interrupt blocks the OpenCode fallback', async () => {
  const dir = temp(), f = stallFixture(dir);
  f.io.threadByNative = async () => ({ threadId: 't', model: { instanceId: 'opencode' }, nativeSessionId: 'ses_a', activeRunId: 'run', state: 'running' });
  await stallScan(f.args(), f.io);
  f.setTime(T0 + 31 * MIN);
  f.io.interruptThread = async () => { f.calls.push(['robob']); await pauseRecovery(dir, {}, T0 + 31 * MIN); return { result: 'no_active_run' }; };
  await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, [['robob']]);
  assert.equal(Object.values(f.state.stalls)[0].ocTries, undefined);
});

test('pause during ghost recheck blocks interruption and leaves no acted stall', async () => {
  const dir = temp(), f = stallFixture(dir);
  f.clear();
  const thread = { threadId: 't', title: 'Ghost', model: { instanceId: 'opencode' }, nativeSessionId: 'ses_a', activeRunId: 'run', state: 'running' };
  f.io.activeThreads = async () => [thread];
  await stallScan(f.args(), f.io);
  f.setTime(T0 + 16 * MIN);
  let reads = 0;
  f.io.activeThreads = async () => { if (++reads === 2) await pauseRecovery(dir, {}, T0 + 16 * MIN); return [thread]; };
  await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state.stalls, {});
});

test('already-sent stall note reconciles once and long pause does not trigger give-up', async () => {
  const dir = temp(), f = stallFixture(dir);
  f.clear();
  f.state.stalls.pending = { at: iso(T0), ses: 'ses_a', threadId: 't', runId: 'run', interruptedAt: T0, action: 'robob',
    note: true, errors: [], title: 'Thread', quietMs: 31 * MIN, kind: 'llm', label: 'waiting' };
  await pauseRecovery(dir, {}, T0);
  await resumeRecovery(dir, T0 + 60 * MIN);
  f.setTime(T0 + 60 * MIN);
  f.io.sendToThread = async () => { f.calls.push(['note']); await pauseRecovery(dir, {}, T0 + 60 * MIN); };
  await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
  assert.equal(f.state.stalls.pending.noted, true);
  assert.ok(!f.state.stalls.pending.done);
  assert.deepEqual(f.calls, [['note']]);
  await resumeRecovery(dir, T0 + 120 * MIN);
  f.setTime(T0 + 120 * MIN);
  await stallScan(f.args(), f.io);
  assert.equal(f.state.stalls.pending.outcome, 'cleared');
  assert.deepEqual(f.calls, [['note'], ['telegram']]);
});

test('late delegated note is guarded and its accepted send survives pause without a duplicate', async () => {
  const dir = temp(), f = fixture(dir), state = stateOf();
  await restartScan(f.args(state), f.io);
  const entry = Object.values(state.handled)[0];
  entry.done = false;
  f.io.cancelledDelegatedTasksSince = () => [{ kind: 'delegated', subagent_id: 'task', taskRef: 'task', thread_id: 't0', childThreadId: 'child',
    run_id: 'cut-t0', completed_at: iso(T0), started_at: iso(T0 - MIN), prompt: 'task prompt' }];
  f.calls.length = 0;
  f.io.sendToThread = async () => { f.calls.push(['late']); await pauseRecovery(dir, {}, T0 + 2 * MIN); };
  await assert.rejects(restartScan(f.args(state), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(entry.threads.t0.deliveredDelegated, ['task']);
  assert.deepEqual(f.calls, [['late']]);
  await resumeRecovery(dir, T0 + 62 * MIN);
  f.setClock(T0 + 62 * MIN);
  await restartScan(f.args(state), f.io);
  assert.deepEqual(f.calls, [['late'], ['telegram']]);
});

test('a real stale scan save never erases pause or prunes old pending work', async () => {
  const dir = temp(), original = realIo.PATHS.dataDir;
  realIo.PATHS.dataDir = dir;
  try {
    const stale = realIo.loadState();
    stale.handled.old = { at: iso(T0), incident: {}, threads: { t: {} } };
    await pauseRecovery(dir, {}, T0);
    realIo.saveState(stale, T0 + 30 * 86_400_000);
    assert.equal(controlStatus(realIo.readControl(), T0 + 30 * 86_400_000).paused, true);
    assert.ok(realIo.loadState().handled.old);
  } finally { realIo.PATHS.dataDir = original; }
});

test('WebSocket setup cannot carry a queued command across a newly arrived pause', async () => {
  const dir = temp(), original = realIo.PATHS.dataDir;
  const wsOriginal = globalThis.WebSocket;
  const env = { url: process.env.T3_CONTROL_URL, token: process.env.T3_CONTROL_TOKEN };
  const handlers = {}, sent = [];
  process.env.T3_CONTROL_URL = 'http://fixture.invalid';
  process.env.T3_CONTROL_TOKEN = 'fixture-token';
  realIo.PATHS.dataDir = dir;
  globalThis.WebSocket = class {
    addEventListener(name, fn) { handlers[name] = fn; }
    send(text) { sent.push(text); }
    close() {}
  };
  try {
    const result = realIo.dispatchCommand({ type: 'queue.resume', threadId: 'fixture' });
    await pauseRecovery(dir);
    handlers.open();
    await assert.rejects(result, { code: 'RECOVERY_PAUSED' });
    assert.deepEqual(sent, []);
  } finally {
    realIo.PATHS.dataDir = original;
    globalThis.WebSocket = wsOriginal;
    for (const [key, value] of [['T3_CONTROL_URL', env.url], ['T3_CONTROL_TOKEN', env.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('paused time does not make a held coordination pulse stale', async () => {
  const dir = temp(), f = fixture(dir), state = stateOf();
  await pauseRecovery(dir, {}, T0);
  await resumeRecovery(dir, T0 + 24 * 60 * MIN);
  f.setClock(T0 + 24 * 60 * MIN);
  f.io.queuedRuns = () => [{ run_id: 'pulse', held: true, requested_at: iso(T0 - MIN), user_message_id: 'ardud-control:send:t0:coord%3Apulse' }];
  f.io.messageText = () => '[coord] pulse';
  await restartScan(f.args(state), f.io);
  assert.ok(f.calls.some(([type]) => type === 'queue.resume'));
  assert.ok(!f.calls.some(([type]) => type === 'queued-run.cancel'));
});


for (const kind of ['ghost', 'robob', 'opencode']) {
  test(`final pause gate before ${kind} interrupt leaves it recoverable after resume`, async () => {
    const dir = temp(), f = stallFixture(dir);
    let thread = { threadId: 't', title: 'Thread', model: { instanceId: 'opencode' },
      nativeSessionId: 'ses_a', activeRunId: 'run', state: 'running' };
    f.io.getThread = async () => thread;
    f.io.activeSessions = async () => new Set(kind === 'ghost' ? [] : ['ses_a']);
    f.io.activeThreads = async () => kind === 'ghost' ? [thread] : [];
    f.io.threadByNative = async () => kind === 'robob' ? thread : null;
    await stallScan(f.args(), f.io);
    const interruptAt = T0 + 31 * MIN;
    f.setTime(interruptAt);
    let injected = false;
    f.io.readControl = () => {
      // Insert the pause only after the new stall is recorded, at the final
      // transport gate. Earlier rechecks cannot cover this interleaving.
      if (!injected && Object.values(f.state.stalls).some((s) => kind !== 'opencode' || s.ocTries > 0)) {
        injected = true;
        writeFileSync(join(dir, 'control.json'), JSON.stringify({ intervals: [{ start: interruptAt, end: null }], reason: 'final gate' }));
      }
      return loadControl(dir);
    };
    await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
    assert.equal(injected, true);
    assert.deepEqual(f.calls, []);
    const resumeAt = interruptAt + 60 * MIN;
    await resumeRecovery(dir, resumeAt);
    f.setTime(resumeAt);
    await stallScan(f.args(), f.io);
    assert.deepEqual(f.calls, [kind === 'opencode' ? ['oc', 'ses_a'] : ['robob']]);
    await stallScan(f.args(), f.io);
    assert.equal(f.calls.length, 1);
    thread = { ...thread, activeRunId: null, state: 'idle' };
    f.io.activeSessions = async () => new Set();
    f.io.activeThreads = async () => [];
    f.setTime(resumeAt + MIN);
    await stallScan(f.args(), f.io);
    assert.equal(f.calls.filter(([type]) => type === 'oc' || type === 'robob').length, 1);
    assert.ok(Object.values(f.state.stalls).every((s) => s.done && s.outcome === 'cleared'));
  });
}

const staleHeldCases = [
  { name: 'fresh coord pulse', age: MIN, coordId: true, text: '[coord] pulse', stale: false },
  { name: 'coord pulse exactly 24 unpaused hours old', age: 24 * 60 * MIN, coordId: true, text: '[coord] pulse', stale: false },
  { name: 'coord pulse older than 24 unpaused hours', age: 24 * 60 * MIN + 1, coordId: true, text: '[coord] pulse', stale: true },
  { name: 'old owner message', age: 72 * 60 * MIN, coordId: false, text: 'owner message', stale: false },
  { name: 'old owner message with coord text', age: 72 * 60 * MIN, coordId: false, text: '[coord] pulse', stale: false },
  { name: 'old coord ID with owner text', age: 72 * 60 * MIN, coordId: true, text: 'owner message', stale: false },
];
for (const row of staleHeldCases) {
  test(`stream-drop stale-held age excludes a 25-hour pause: ${row.name}`, async () => {
    const dir = temp(), f = fixture(dir);
    const resumeAt = T0 + 25 * 60 * MIN;
    const dropAt = resumeAt - MIN;
    await pauseRecovery(dir, {}, T0);
    await resumeRecovery(dir, resumeAt);
    f.setClock(resumeAt);
    const queued = { run_id: 'held', held: true, requested_at: iso(T0 - row.age),
      user_message_id: row.coordId ? 'ardud-control:send:t0:coord%3Apulse' : 'owner' };
    f.io.queuedRuns = () => [queued];
    f.io.messageText = () => row.text;
    f.io.laterRuns = () => [];
    f.io.ocSession = async () => ({ time: { updated: dropAt } });
    f.io.ocMessages = async () => ({ messages: [], complete: true });
    f.io.threadMessageIdsSince = () => [];
    f.io.ocForms = async () => [];
    const incident = { id: 'drop-paused', startMs: dropAt, endMs: dropAt, failAllMs: dropAt,
      runs: [{ thread_id: 't0', run_id: 'cut-t0', ordinal: 1, requested_at: iso(dropAt - MIN), completed_at: iso(dropAt) }], subagents: [] };
    const g = await gatherThread({ db: null, incident, threadId: 't0', active: new Set(), now: resumeAt }, f.io);
    const result = await act({ db: null, incident, g }, f.io);
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls.filter(([type]) => type === 'queued-run.cancel'), row.stale ? [['queued-run.cancel', 't0']] : []);
    assert.deepEqual(g.staleHeld.map((r) => r.run_id), row.stale ? ['held'] : []);
    assert.deepEqual(f.calls.filter(([type]) => type === 'queue.resume'), row.stale ? [] : [['queue.resume', 't0']]);
  });
}


test('final pause gate on fallback retains the accepted Robob interrupt and retries only OpenCode', async () => {
  const dir = temp(), f = stallFixture(dir);
  f.io.activeSessions = async () => new Set(['ses_a']);
  f.io.threadByNative = async () => ({ threadId: 't', model: { instanceId: 'opencode' },
    nativeSessionId: 'ses_a', activeRunId: 'run', state: 'running' });
  f.io.interruptThread = async () => { f.calls.push(['robob']); return { result: 'no_active_run' }; };
  await stallScan(f.args(), f.io);
  const interruptAt = T0 + 31 * MIN;
  f.setTime(interruptAt);
  let injected = false;
  f.io.readControl = () => {
    if (!injected && Object.values(f.state.stalls).some((s) => s.ocTries > 0)) {
      injected = true;
      writeFileSync(join(dir, 'control.json'), JSON.stringify({ intervals: [{ start: interruptAt, end: null }], reason: 'fallback gate' }));
    }
    return loadControl(dir);
  };
  await assert.rejects(stallScan(f.args(), f.io), { code: 'RECOVERY_PAUSED' });
  assert.deepEqual(f.calls, [['robob']]);
  const [stall] = Object.values(f.state.stalls);
  assert.equal(stall.robobResult, 'no_active_run');
  assert.equal(stall.ocTries, 0);
  assert.ok(!stall.done);
  const resumeAt = interruptAt + 60 * MIN;
  await resumeRecovery(dir, resumeAt);
  f.setTime(resumeAt + FALLBACK_MS);
  await stallScan(f.args(), f.io);
  await stallScan(f.args(), f.io);
  assert.deepEqual(f.calls, [['robob'], ['oc', 'ses_a']]);
});
