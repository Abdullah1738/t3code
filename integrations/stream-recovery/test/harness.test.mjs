import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCodeSession, cutoverOwns, parseCutoverStatus } from '../lib/harness.mjs';
import { ghostCandidates, planStall, LLM_QUIET_MS } from '../lib/stall.mjs';
import { gatherThread, act } from '../cli.mjs';
import { planInstallerResume } from '../scripts/installer-resume-plan.mjs';
import * as io from '../lib/io.mjs';

const status = (over = {}) => ({ active: false, completed: false, claimedThreadIds: [], claimedRunIds: [], ...over });
const old = { threadId: 't', state: 'running', activeRunId: 'r', nativeSessionId: 'ses_old', model: { instanceId: 'opencode' } };

test('provider identity, not ses_ aliases, controls OpenCode liveness', () => {
  assert.equal(openCodeSession(old), 'ses_old');
  for (const instanceId of ['claudeAgent', 'codex', 'codex-cu']) {
    const switched = { ...old, model: { instanceId } };
    assert.equal(openCodeSession(switched), null);
    assert.deepEqual(ghostCandidates([switched], new Set()), []);
    assert.equal(openCodeSession({ ...switched, native: { driver: instanceId === 'claudeAgent' ? 'claudeAgent' : 'codex',
      providerInstanceId: instanceId, nativeId: 'ses_old' } }), null);
    assert.equal(planStall({ ses: 'ses_old', kind: 'llm', quietMs: LLM_QUIET_MS, limitMs: LLM_QUIET_MS, thread: switched }).action, 'opencode');
  }
  assert.equal(openCodeSession({ nativeSessionId: 'ses_unknown' }), null);
  assert.equal(openCodeSession({ ...old, native: { driver: 'codex', nativeId: 'uuid' } }), null);
});

test('completed ownership suppresses old runs only, active ownership also covers a not-yet-switched thread', () => {
  assert.equal(cutoverOwns(status({ active: true, claimedThreadIds: ['t'] }), 't', ['new']), true);
  const completed = status({ completed: true, claimedThreadIds: ['t'], claimedRunIds: ['old'] });
  assert.equal(cutoverOwns(completed, 't', ['old']), true);
  assert.equal(cutoverOwns(completed, 't', ['new']), false);
  assert.equal(cutoverOwns(completed, 't'), false);
  assert.equal(cutoverOwns(status({ completed: true, claimedRuns: [{ threadId: 't', runId: 'old' }] }), 't', ['old']), true);
  assert.equal(cutoverOwns(status({ completed: true, claimedRuns: [{ threadId: 'other', runId: 'old' }] }), 't', ['old']), false);
});

test('status errors and HTML fallback are never treated as no claims', () => {
  for (const body of [null, {}, '<html>', { ok: true, cutover: {} }, { ok: true, cutover: status({ claimedRunIds: [1] }) }]) {
    assert.throws(() => parseCutoverStatus(body), /invalid harness-cutover/);
  }
  assert.deepEqual(parseCutoverStatus({ ok: true, cutover: status() }), status());
});

test('all session-specific OpenCode routes reject native UUIDs before reading credentials or fetching', async () => {
  for (const fn of [io.ocSession, io.ocMessages, io.ocForms, io.ocPermissions, io.ocTail, io.ocInterrupt, io.ocChildren]) {
    await assert.rejects(() => fn('native-uuid'), /non-OpenCode session ID/);
  }
});

test('stream-loss recovery does not read native sessions or release their queues', async () => {
  const incident = { runs: [{ thread_id: 't', run_id: 'r' }], subagents: [] };
  for (const native of [{ ...old, model: { instanceId: 'codex' } }, old]) {
    const fake = { getThread: async () => native, harnessCutoverStatus: async () => status({ active: true, claimedThreadIds: ['t'] }) };
    const g = await gatherThread({ db: null, incident, threadId: 't' }, fake);
    assert.equal(g.plan.action, 'skip');
    assert.equal(g.plan.resumeQueue, false);
    assert.equal((await act({ incident, g }, fake)).plan.action, 'skip');
  }
  const fake = { getThread: async () => ({ ...old, model: { instanceId: 'claudeAgent' } }), harnessCutoverStatus: async () => status() };
  assert.match((await gatherThread({ incident, threadId: 't' }, fake)).plan.reason, /not a current OpenCode/);
});

test('claim arriving after stream-loss gathering prevents both note and queue release', async () => {
  const g = { thread: old, sourceRuns: ['r'], plan: { threadId: 't', action: 'note', resumeQueue: true }, lost: [], forms: [] };
  const fake = { harnessCutoverStatus: async () => status({ active: true, claimedThreadIds: ['t'] }) };
  assert.equal((await act({ incident: {}, g }, fake)).plan.action, 'skip');
});

test('installer plan keeps active claims pending, retires completed exact cuts, and permits future restarts', () => {
  const snapshot = { threads: [{ threadId: 't', activeRunId: 'old' }, { threadId: 'other', activeRunId: 'x' }] };
  assert.deepEqual(planInstallerResume(snapshot, status({ active: true, claimedThreadIds: ['t'] })), {
    resumeThreadIds: ['other'], cutoverPendingThreadIds: ['t'], cutoverCompletedThreadIds: [], unresolvedThreadIds: [],
  });
  const completed = status({ completed: true, claimedThreadIds: ['t'], claimedRunIds: ['old'] });
  assert.deepEqual(planInstallerResume(snapshot, completed).cutoverCompletedThreadIds, ['t']);
  assert.deepEqual(planInstallerResume({ threads: [{ threadId: 't', activeRunId: 'future' }] }, completed).resumeThreadIds, ['t']);
  assert.deepEqual(planInstallerResume({ threads: [{ threadId: 't' }] }, completed).unresolvedThreadIds, ['t']);
});
