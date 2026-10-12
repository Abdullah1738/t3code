import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAM_LOST, findIncidents, lostMessages, invisibleReply, orphanStatus, planThread,
  buildNote, buildSummary, incidentId, sessionFromProviderThread, providerThreadFor,
  turnPromptId, steerPromptId, robobNativeMessageId,
} from '../lib/detect.mjs';

const T0 = Date.parse('2026-10-10T11:38:19.360Z');
const iso = (ms) => new Date(ms).toISOString();

test('ids and session parsing', () => {
  assert.equal(incidentId(T0), 'sr-20261010T113819Z');
  assert.equal(sessionFromProviderThread('provider-thread:provider:opencode:provider-instance:opencode:native-thread:ses_abc123'), 'ses_abc123');
  assert.equal(providerThreadFor('thread:provider:opencode:x:native-thread:ses_a'), 'provider-thread:provider:opencode:x:native-thread:ses_a');
  assert.equal(turnPromptId('ses_a', 'att'), 'msg_t3_turn_ses_a:att');
  assert.equal(steerPromptId('ses_a', 'm1'), 'msg_t3_steer_ses_a:m1');
  assert.equal(robobNativeMessageId('message:provider:opencode:native-item:msg_XYZ%3Atext%3A0'), 'msg_XYZ');
});

test('findIncidents groups a stream-loss burst and ignores other failures', () => {
  const subs = [0, 2, 4].map((d) => ({ kind: 'subagent', at: iso(T0 + d), result: null }));
  const runs = [
    { kind: 'run', at: iso(T0 + 7_000), error: STREAM_LOST, threadId: 'a' },
    { kind: 'run', at: iso(T0 + 100_000), error: STREAM_LOST, threadId: 'b' },
  ];
  const noise = [
    { kind: 'run', at: iso(T0 + 3 * 3600_000), error: '[429] usage limit', threadId: 'c' },
    { kind: 'subagent', at: iso(T0 + 3 * 3600_000), result: 'Timed out waiting for response data' },
  ];
  const incidents = findIncidents([...subs, ...runs, ...noise]);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].runs.length, 2);
  assert.equal(incidents[0].subagents.length, 3);
  assert.equal(incidents[0].failAllMs, T0);
});

test('findIncidents needs a stream-lost run or a real burst', () => {
  const lone = [{ kind: 'subagent', at: iso(T0), result: null }];
  assert.equal(findIncidents(lone).length, 0);
  // Mass 400s leave a few result-less subagents at one instant; not a stream drop.
  const burst = [0, 0, 0].map((d) => ({ kind: 'subagent', at: iso(T0 + d), result: null }));
  const bad = [{ kind: 'run', at: iso(T0 + 1_000), error: '[400] invalid_request_error', threadId: 'x' }];
  assert.equal(findIncidents([...burst, ...bad]).length, 0);
  const closed = [{ kind: 'run', at: iso(T0 + 1_000), error: 'The provider event stream closed unexpectedly. Retry the turn.', threadId: 'y' }];
  assert.equal(findIncidents([...burst, ...closed]).length, 1);
});

test('lostMessages matches turn and steer prompt ids', () => {
  const robobMessages = [
    { messageId: 'u1', text: 'start the turn', primary: true },
    { messageId: 'u2', text: 'a steer that arrived', primary: false },
    { messageId: 'u3', text: 'a steer that never arrived', primary: false },
  ];
  const ocUserMessages = [
    { id: 'msg_t3_turn_ses_a:att1', text: 'start the turn' },
    { id: 'msg_t3_steer_ses_a:u2', text: 'a steer that arrived' },
  ];
  const lost = lostMessages({ sessionId: 'ses_a', attemptId: 'att1', robobMessages, ocUserMessages });
  assert.deepEqual(lost.map((m) => m.messageId), ['u3']);
});

test('invisibleReply finds an assistant reply Robob never saw', () => {
  const msg = (id, at, text) => ({ id, type: 'assistant', time: { created: at }, content: [{ type: 'text', text }] });
  const ocMessages = [msg('msg_new', T0 + 60_000, 'done'), msg('msg_old', T0 - 3600_000, 'old')];
  const r = invisibleReply({ ocMessages, sinceMs: T0, robobNativeIds: new Set() });
  assert.equal(r.id, 'msg_new');
  assert.equal(invisibleReply({ ocMessages, sinceMs: T0, robobNativeIds: new Set(['msg_new']) }), null);
});

test('orphanStatus', () => {
  assert.equal(orphanStatus({ active: true, updatedMs: T0, failAllMs: T0 }), 'running');
  assert.equal(orphanStatus({ active: false, updatedMs: T0 + 600_000, failAllMs: T0 }), 'finished');
  assert.equal(orphanStatus({ active: false, updatedMs: T0 - 86400_000, failAllMs: T0 }), 'stale');
});

const base = (over = {}) => ({
  thread: { threadId: 't1', title: 'Lane', origin: null, archived: false, nativeSessionId: 'ses_a' },
  failedRuns: [{ completedAt: iso(T0) }],
  recovered: false,
  session: { active: true, updatedMs: T0 },
  ...over,
});

test('planThread decisions', () => {
  assert.equal(planThread(base()).action, 'note');
  assert.equal(planThread(base({ thread: { ...base().thread, archived: true } })).action, 'skip');
  assert.equal(planThread(base({ thread: { ...base().thread, origin: 'crw' } })).action, 'skip');
  assert.equal(planThread(base({ thread: { ...base().thread, origin: 'crw' }, held: [{}] })).action, 'release');
  assert.equal(planThread(base({ thread: { ...base().thread, origin: 'imessage' }, lost: [{}] })).action, 'report');
  assert.equal(planThread(base({ recovered: true })).action, 'skip');
  assert.equal(planThread(base({ recovered: true, orphans: [{ status: 'running' }] })).action, 'note');
  assert.equal(planThread(base({ recovered: true, orphans: [{ status: 'stale' }] })).action, 'skip');
  const stale = planThread(base({ session: { active: false, updatedMs: T0 - 7 * 3600_000 } }));
  assert.equal(stale.action, 'skip');
  assert.equal(planThread(base({ held: [{}] })).resumeQueue, true);
});

test('buildNote and buildSummary', () => {
  const incident = { id: incidentId(T0), startMs: T0, endMs: T0 + 100_000, failAllMs: T0, runs: [{ threadId: 't1' }], subagents: [{}] };
  const plan = planThread(base());
  const note = buildNote({
    incident, plan, ocUrl: 'http://127.0.0.1:49374',
    lost: [{ messageId: 'u3', text: 'please continue' }],
    orphans: [{ sessionId: 'ses_child', title: 'worker', status: 'running', updatedMs: T0 }],
    forms: [{ sessionId: 'ses_child', formId: 'frm_1', title: 'cap?', fields: [{ key: 'q0', title: 'cap?', options: [{ label: 'Yes', value: 'Yes' }] }] }],
  });
  assert.match(note, /^\[stream-recovery\]/);
  assert.match(note, /please continue/);
  assert.match(note, /ses_child/);
  assert.match(note, /frm_1/);
  const s = buildSummary({ incident, results: [{ plan, ok: true, forms: [{}] }] });
  assert.equal(s.severity, 'attention');
  assert.match(s.text, /OpenCode stream drop at 11:38Z/);
});
