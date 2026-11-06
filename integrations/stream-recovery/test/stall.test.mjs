import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallScan } from '../lib/stallwatch.mjs';
import {
  LLM_QUIET_MS, TOOL_QUIET_MS, NO_TIMEOUT_MS, SHELL_MARGIN_MS, SHELL_DEFAULT_TIMEOUT_MS, MAX_PER_DAY,
  tailActivity, toolLimit, observe, quietSince,
  fingerprint, planStall, stallCleared, stallId, buildStallNote, buildStallSummary,
} from '../lib/stall.mjs';

const T0 = Date.parse('2026-10-13T07:31:05Z');
const tool = (name, status, time = { created: T0 }, input) => ({ type: 'tool', id: name, name, state: { status, input }, time });

test('tailActivity reads the newest timestamp across messages and parts', () => {
  const messages = [
    { type: 'assistant', time: { created: T0 }, content: [{ type: 'text', text: 'hi' }, tool('shell', 'completed', { created: T0, ran: T0 + 5, completed: T0 + 9_000 })] },
    { type: 'user', time: { created: T0 - 60_000 }, content: [] },
  ];
  assert.equal(tailActivity(messages).lastMs, T0 + 9_000);
  assert.equal(tailActivity([{ type: 'assistant', time: { created: T0 }, retry: { attempt: 2, at: T0 + 50_000 }, content: [] }]).lastMs, T0 + 50_000);
  assert.equal(tailActivity([]).lastMs, 0);
});

test('tailActivity classifies what the session waits on', () => {
  const kind = (...parts) => tailActivity([{ type: 'assistant', time: { created: T0 }, content: parts }]);
  assert.equal(kind(tool('shell', 'streaming'), tool('read', 'streaming')).kind, 'llm');
  assert.match(kind(tool('shell', 'streaming')).label, /died mid tool call \(shell\)/);
  assert.equal(kind(tool('shell', 'running')).kind, 'tool');
  assert.equal(kind(tool('subagent', 'running')).kind, 'subagent');
  assert.equal(kind(tool('question', 'running'), tool('shell', 'running')).kind, 'user');
  assert.equal(kind({ type: 'reasoning', text: '...' }).kind, 'llm');
  assert.equal(kind(tool('shell', 'completed')).kind, 'llm');
});

test('limits: model 30 min, shells their own timeout plus a margin, other tools 2h, user waits never', () => {
  const limit = (...parts) => tailActivity([{ type: 'assistant', time: { created: T0 }, content: parts }]).limitMs;
  assert.equal(limit(tool('shell', 'streaming')), LLM_QUIET_MS);
  assert.equal(limit({ type: 'text', text: 'x' }), LLM_QUIET_MS);
  assert.equal(limit(tool('shell', 'running', undefined, { command: 'ls' })), SHELL_DEFAULT_TIMEOUT_MS + SHELL_MARGIN_MS);
  assert.equal(limit(tool('shell', 'running', undefined, { command: 'x', timeout: 3_600_000 })), 3_600_000 + SHELL_MARGIN_MS);
  assert.equal(limit(tool('shell', 'running', undefined, { command: 'x', timeout: 0 })), NO_TIMEOUT_MS);
  assert.equal(limit(tool('execute', 'running')), 20 * 60_000);
  assert.equal(limit(tool('read', 'running')), TOOL_QUIET_MS);
  assert.equal(limit(tool('subagent', 'running')), TOOL_QUIET_MS);
  assert.equal(limit(tool('question', 'running')), Infinity);
  assert.equal(limit(tool('question', 'running'), tool('execute', 'running', undefined, { code: 'new Promise(r=>r)' })), Infinity);
  assert.equal(limit(tool('subagent', 'running'), tool('execute', 'running', undefined, { code: 'new Promise(r=>r)' })), TOOL_QUIET_MS);
  // The longest running tool wins.
  assert.equal(limit(tool('shell', 'running', undefined, { command: 'x' }), tool('execute', 'running')), SHELL_DEFAULT_TIMEOUT_MS + SHELL_MARGIN_MS);
  assert.equal(toolLimit({ name: 'shell', state: { input: { timeout: 'junk' } } }), SHELL_DEFAULT_TIMEOUT_MS + SHELL_MARGIN_MS);
});

test('execute waits with a never-settling promise get three minutes and name the cause', () => {
  for (const code of ['await new Promise(r=>r)', 'await new Promise(()=>{})', 'await tools.dia.dia_navigate({}); await new Promise(r => r)']) {
    const part = tool('execute', 'running', undefined, { code });
    const activity = tailActivity([{ content: [part] }]);
    assert.equal(toolLimit(part), 3 * 60_000);
    assert.equal(activity.limitMs, 3 * 60_000);
    assert.equal(activity.label, 'running execute (code awaits a promise that never resolves)');
    assert.equal(planStall({ ...base, ...activity, quietMs: 3 * 60_000 - 1, thread: thread() }).action, 'skip');
    assert.equal(planStall({ ...base, ...activity, quietMs: 3 * 60_000, thread: thread() }).action, 'robob');
    const stall = { ...activity, quietSince: T0, quietMs: 3 * 60_000, outcome: 'cleared', action: 'robob' };
    assert.match(buildStallNote(stall), /execute \(code awaits a promise that never resolves\)/);
    assert.match(buildStallSummary(stall).text, /execute \(code awaits a promise that never resolves\)/);
  }
});

test('normal execute calls get twenty minutes, including missing or malformed input', () => {
  for (const input of [undefined, {}, { code: null }, { code: 3 }, { code: 'return await tools.perplexity.perplexity_research({});' }, { code: 'new Promise(r => setTimeout(r, 10))' },
    { code: 'return await new Promise(function() { arguments[0](42); });' },
    { code: 'return await new Promise(function() { arguments[1]("no"); });' },
    { code: 'if (true) /new Promise(r=>r)/.test("test"); return 1;' }]) {
    const part = tool('execute', 'running', undefined, input);
    assert.equal(toolLimit(part), 20 * 60_000);
    assert.equal(tailActivity([{ content: [part] }]).label, 'running execute');
  }
});

test('stallScan interrupts a child stuck in execute at three minutes, not before, and reports the cause', async () => {
  let active = new Set(['ses_child']);
  const calls = { interrupts: [], summaries: [] };
  const state = { watch: {}, stalls: {}, ghosts: {} };
  const log = () => {};
  const messages = [{ type: 'assistant', time: { created: T0 }, content: [tool('execute', 'running', undefined, { code: 'await new Promise(r=>r)' })] }];
  const io = {
    activeSessions: async () => active,
    ocTail: async () => messages,
    ocSession: async (ses) => ({ title: ses, ...(ses === 'ses_child' ? { parentID: 'ses_parent' } : {}) }),
    ocForms: async () => [], ocPermissions: async () => [], threadByNative: async () => null,
    ocInterrupt: async ses => { calls.interrupts.push(ses); },
    activeThreads: async () => [], installerResumePendingMs: () => null,
    telegram: value => { calls.summaries.push(value); },
  };
  await stallScan({ state, now: T0, log }, io);
  await stallScan({ state, now: T0 + 3 * 60_000 - 1, log }, io);
  assert.deepEqual(calls.interrupts, []);
  await stallScan({ state, now: T0 + 3 * 60_000, log }, io);
  assert.deepEqual(calls.interrupts, ['ses_child']);
  active = new Set();
  await stallScan({ state, now: T0 + 4 * 60_000, log }, io);
  assert.equal(calls.summaries.length, 1);
  assert.match(calls.summaries[0].text, /execute \(code awaits a promise that never resolves\)/);
  assert.equal(Object.values(state.stalls)[0].outcome, 'cleared');
});

test('tailActivity sees a running tool behind a newer message', () => {
  const messages = [
    { type: 'synthetic', time: { created: T0 + 1000 }, content: [{ type: 'text', text: 'shell finished in background' }] },
    { type: 'assistant', time: { created: T0 }, content: [tool('subagent', 'running')] },
  ];
  assert.equal(tailActivity(messages).kind, 'subagent');
});

test('observe restarts the clock on first sighting and on any change', () => {
  const a = observe(undefined, 'fp1', 1000);
  assert.deepEqual(a, { fp: 'fp1', since: 1000 });
  assert.equal(observe(a, 'fp1', 5000), a);
  assert.deepEqual(observe(a, 'fp2', 5000), { fp: 'fp2', since: 5000 });
  // A first sighting never trusts old timestamps: text parts carry none.
  assert.equal(quietSince(a, 0), 1000);
  assert.equal(quietSince(a, 4000), 4000);
  assert.equal(fingerprint([{ a: 1 }]), fingerprint([{ a: 1 }]));
  assert.notEqual(fingerprint([{ a: 1 }]), fingerprint([{ a: 2 }]));
});

const thread = (over = {}) => ({ threadId: 'ardud-control:thread:x', nativeSessionId: 'ses_x', title: 'T', origin: null, archived: false, activeRunId: 'run:1', pendingRequests: [], ...over });
const base = { ses: 'ses_x', kind: 'llm', limitMs: LLM_QUIET_MS, quietMs: LLM_QUIET_MS + 1, waiting: false, childActive: false, parentID: undefined, recent: 0 };

test('planStall interrupts a hung top-level thread through Robob with a note', () => {
  assert.deepEqual(planStall({ ...base, thread: thread() }), { action: 'robob', note: true, reason: 'hung turn' });
});

test('planStall leaves sessions alone until they are quiet long enough', () => {
  assert.equal(planStall({ ...base, quietMs: LLM_QUIET_MS - 1, thread: thread() }).action, 'skip');
  assert.equal(planStall({ ...base, kind: 'tool', limitMs: TOOL_QUIET_MS, quietMs: LLM_QUIET_MS + 1, thread: thread() }).action, 'skip');
  assert.equal(planStall({ ...base, kind: 'tool', limitMs: TOOL_QUIET_MS, quietMs: TOOL_QUIET_MS + 1, thread: thread() }).action, 'robob');
});

test('planStall never touches sessions waiting on a person or a live subagent', () => {
  assert.equal(planStall({ ...base, kind: 'user', limitMs: Infinity, quietMs: 1e12, thread: thread() }).action, 'skip');
  assert.equal(planStall({ ...base, waiting: true, thread: thread() }).action, 'skip');
  assert.equal(planStall({ ...base, thread: thread({ pendingRequests: [{ id: 'r' }] }) }).action, 'skip');
  const sub = { ...base, kind: 'subagent', limitMs: TOOL_QUIET_MS, quietMs: TOOL_QUIET_MS + 1 };
  assert.equal(planStall({ ...sub, childActive: true, thread: thread() }).action, 'skip');
  assert.equal(planStall({ ...sub, childActive: false, thread: thread() }).action, 'robob');
});

test('planStall: crw, iMessage and archived threads are interrupted without a note', () => {
  assert.deepEqual(planStall({ ...base, thread: thread({ origin: 'crw' }) }), { action: 'robob', note: false, reason: 'crw thread (crw nudges it once idle)' });
  assert.equal(planStall({ ...base, thread: thread({ origin: 'imessage' }) }).note, false);
  assert.equal(planStall({ ...base, thread: thread({ archived: true }) }).note, false);
});

test('planStall interrupts subagent sessions in OpenCode directly', () => {
  assert.equal(planStall({ ...base, parentID: 'ses_parent', thread: null }).action, 'opencode');
  const nested = thread({ threadId: 'thread:provider:opencode:provider-instance:opencode:native-thread:ses_c', activeRunId: null });
  assert.equal(planStall({ ...base, thread: nested }).action, 'opencode');
});

test('planStall never interrupts Robob for an old session of a thread that moved on', () => {
  assert.deepEqual(planStall({ ...base, thread: thread({ nativeSessionId: 'ses_new' }) }), { action: 'opencode', note: false, reason: 'old session of a thread that moved on' });
});

test('planStall interrupts unmapped sessions in OpenCode and reports repeats', () => {
  assert.deepEqual(planStall({ ...base, thread: null }), { action: 'opencode', note: false, reason: 'no Robob thread for this session' });
  const r = planStall({ ...base, thread: thread(), recent: MAX_PER_DAY });
  assert.equal(r.action, 'report');
  assert.match(r.reason, /3 times in 24h/);
});

test('stallCleared needs both Robob and OpenCode to let go', () => {
  const stall = { threadId: 'ardud-control:thread:x', runId: 'run:1', fp: 'fp1' };
  assert.equal(stallCleared({ stall, active: false, fp: null, thread: thread({ activeRunId: null }) }).cleared, true);
  assert.deepEqual(stallCleared({ stall, active: false, fp: null, thread: thread() }), { robobDone: false, ocDone: true, cleared: false });
  assert.deepEqual(stallCleared({ stall, active: true, fp: 'fp1', thread: thread({ activeRunId: 'run:2' }) }), { robobDone: true, ocDone: false, cleared: false });
  // OpenCode moved on (new output) and Robob started a newer run.
  assert.equal(stallCleared({ stall, active: true, fp: 'fp2', thread: thread({ activeRunId: 'run:2' }) }).cleared, true);
  assert.equal(stallCleared({ stall: { ...stall, threadId: null, runId: null }, active: false, fp: null, thread: null }).cleared, true);
});

test('stall ids are stable per session and quiet start', () => {
  assert.equal(stallId('ses_abc', T0), 'st-ses_abc-20261013T073105Z');
});

test('note and summary say what happened', () => {
  const stall = {
    ses: 'ses_abc', title: 'CRPKO backoffice-frontend#174 | We fix', origin: 'crw', kind: 'llm',
    label: 'model stream died mid tool call (shell, read)', quietSince: T0, quietMs: 900 * 60_000,
    action: 'robob', note: false, reason: 'crw thread (crw nudges it once idle)', outcome: 'cleared', errors: [],
  };
  assert.match(buildStallNote(stall), /^\[stream-recovery\] This thread hung: OpenCode stopped making progress at 07:31Z/);
  assert.match(buildStallNote(stall), /never ran/);
  const s = buildStallSummary(stall);
  assert.equal(s.severity, 'info');
  assert.match(s.text, /sat 900 min/);
  assert.match(s.text, /Interrupted \(crw thread/);
  assert.equal(buildStallSummary({ ...stall, outcome: 'report', reason: 'no Robob thread for this session' }).severity, 'attention');
  const failed = buildStallSummary({ ...stall, outcome: 'failed', detail: 'OpenCode session still running after the interrupt' });
  assert.equal(failed.severity, 'error');
  assert.match(failed.text, /Could not clear it: OpenCode session still running/);
});
