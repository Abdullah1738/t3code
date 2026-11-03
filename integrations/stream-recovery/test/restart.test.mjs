import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as dbIo from '../lib/io.mjs';
import { restartRunsSince, queuedRuns, restartNoteRun, stoppedSince } from '../lib/io.mjs';
import {
  findRestartIncidents, serverStartWindow, trackServer, findRedispatch, normTitle, childOutcome,
  planRestartThread, buildRestartNote, buildRestartSummary, restartIncidentId, RESTART_STALE_REASON,
  RESTART_RESUMED_REASON,
} from '../lib/detect.mjs';
import { restartScan, RESTART_SETTLE_MS, RESTART_RESUME_WINDOW_MS } from '../lib/restartwatch.mjs';

// Fixtures modelled on the 15 Oct 18:17Z restart (statev2 rows, OpenCode messages).
const T0 = Date.parse('2026-10-15T18:17:44.747Z');
const iso = (ms) => new Date(ms).toISOString();
const pt = (ses) => `provider-thread:provider:opencode:provider-instance:opencode:native-thread:${ses}`;
const sub = (id, threadId, dMs, over = {}) => ({
  subagent_id: `node:provider:opencode:native-item:${id}`, thread_id: threadId, run_id: `run:${threadId}:1`,
  provider_thread_id: pt(`ses_${id}`), started_at: iso(T0 - 15 * 60_000), completed_at: iso(T0 + dMs),
  result: null, title: `worker ${id}`, prompt: `Do task ${id}. Read /tmp/${id}.md first.`, model: 'opus/claude-opus-5-5',
  ...over,
});

const restartBurst = () => [
  sub('a1', 'batch', 1_172), sub('a2', 'batch', 1_172), sub('a3', 'batch', 1_172),
  sub('k1', 'kafka', 2_524), sub('p1', 'pbdraft', 3_427), sub('t1', 'tc3', 4_335),
];

test('restart burst across threads is one incident', () => {
  const incidents = findRestartIncidents(restartBurst());
  assert.equal(incidents.length, 1);
  const [i] = incidents;
  assert.equal(i.id, restartIncidentId(T0 + 1_172));
  assert.equal(i.id, 'rs-20261015T181745Z');
  assert.equal(i.reason, 'burst');
  assert.equal(i.subagents.length, 6);
  assert.deepEqual([...new Set(i.subagents.map((s) => s.parentThreadId))], ['batch', 'kafka', 'pbdraft', 'tc3']);
});

test('single-thread user stop is not an incident', () => {
  // A Stop cancels one thread's run and its children at one instant.
  const stop = [sub('s1', 'lane', 0), sub('s2', 'lane', 0), sub('s3', 'lane', 50), sub('s4', 'lane', 80)];
  assert.equal(findRestartIncidents(stop).length, 0);
  // Nested children of the same thread tree still count as one thread.
  const nested = [
    sub('n1', 'lane', 0),
    sub('n2', 'thread:provider:opencode:x:native-thread:ses_n1', 10, { parentThreadId: 'lane', rootThreadId: 'lane' }),
    sub('n3', 'thread:provider:opencode:x:native-thread:ses_n1', 20, { parentThreadId: 'lane', rootThreadId: 'lane' }),
  ];
  assert.equal(findRestartIncidents(nested).length, 0);
  // Two unrelated single cancels minutes apart are not a burst either.
  assert.equal(findRestartIncidents([sub('x', 'a', 0), sub('y', 'b', 5 * 60_000), sub('z', 'c', 10 * 60_000)]).length, 0);
  // Subagents with a result were finished, not cut.
  assert.equal(findRestartIncidents(restartBurst().map((s) => ({ ...s, result: 'done' }))).length, 0);
});

test('single-thread stop that coincides with a server start is an incident', () => {
  const stop = [sub('s1', 'lane', 0)];
  const server = { pid: 81615, procStartMs: Date.parse('2026-10-15T18:16:17Z'), readyMs: Date.parse('2026-10-15T18:17:53.316Z') };
  const [i] = findRestartIncidents(stop, { serverStarts: [server] });
  assert.equal(i.reason, 'server start');
  assert.equal(i.serverStart.pid, 81615);
  // Same cancel an hour later is not.
  assert.equal(findRestartIncidents([sub('s1', 'lane', 3_600_000)], { serverStarts: [server] }).length, 0);
});

test('serverStartWindow covers shutdown back to the last scan that saw the old server', () => {
  const readyMs = T0 + 9_000;
  const w = serverStartWindow({ readyMs, procStartMs: T0 - 90_000, prevSeenMs: T0 - 4 * 60_000 });
  assert.equal(w.from, T0 - 4 * 60_000);
  assert.equal(w.to, readyMs + 60_000);
  // Without a previous sighting: process start minus a minute.
  assert.equal(serverStartWindow({ readyMs, procStartMs: T0 - 90_000 }).from, T0 - 150_000);
  // Never reaches back more than 30 min.
  assert.equal(serverStartWindow({ readyMs, procStartMs: T0, prevSeenMs: T0 - 86_400_000 }).from, T0 - 30 * 60_000);
  assert.equal(serverStartWindow({}), null);
});

test('trackServer records new servers with the previous sighting', () => {
  let list = trackServer([], { pid: 1, readyMs: 100 }, 1_000);
  list = trackServer(list, { pid: 1, readyMs: 100 }, 2_000);
  assert.deepEqual(list.map((s) => [s.pid, s.lastSeenMs]), [[1, 2_000]]);
  list = trackServer(list, null, 3_000);
  list = trackServer(list, { pid: 2, readyMs: 3_500 }, 4_000);
  assert.equal(list.length, 2);
  assert.equal(list[1].prevSeenMs, 2_000);
});

test('findRedispatch matches a resumed session or a relaunch under the same title', () => {
  const lost = { ...sub('a1', 'batch', 1_172, { title: 'CRP-12459 spot base volume' }), sessionId: 'ses_a1' };
  const later = (title, ses, dMs = 150_000) => ({ subagent_id: `x-${title}`, title, provider_thread_id: pt(ses), started_at: iso(T0 + dMs) });
  assert.ok(findRedispatch(lost, [later('anything', 'ses_a1')]));
  assert.ok(findRedispatch(lost, [later('CRP-12459 spot base volume (resume)', 'ses_new')]));
  assert.equal(findRedispatch(lost, [later('CRP-12459 spot base volume follow-up', 'ses_new')]), null);
  assert.equal(findRedispatch(lost, [later('CRP-12459 spot base volume', 'ses_new', -3_600_000)]), null);
  assert.equal(normTitle('Astra final r3 TC#248 (retry)'), 'astra final r3 tc#248');
});

test('childOutcome tells finished from cut from stale', () => {
  const done = [
    { type: 'idle', time: { created: T0 - 200_000 } },
    { type: 'assistant', finish: 'stop', model: { providerID: 'opus', id: 'claude-haiku-5-5' }, time: { created: T0 - 300_000, completed: T0 - 290_000 }, content: [{ type: 'text', text: 'Fixed it in 4832395cb.' }] },
  ];
  const out = childOutcome(done, { incidentMs: T0 });
  assert.equal(out.status, 'finished');
  assert.equal(out.excerpt, 'Fixed it in 4832395cb.');
  assert.equal(out.model, 'opus/claude-haiku-5-5');
  const cut = [{ type: 'assistant', finish: 'tool-calls', time: { created: T0 - 60_000 }, content: [] }];
  assert.equal(childOutcome(cut, { incidentMs: T0 }).status, 'cut');
  assert.equal(childOutcome([], { incidentMs: T0 }).status, 'cut');
  const old = [{ type: 'assistant', finish: 'tool-calls', time: { created: T0 - 2 * 86_400_000 }, content: [] }];
  assert.equal(childOutcome(old, { incidentMs: T0 }).status, 'stale');
});

test('planRestartThread', () => {
  const thread = { threadId: 't', title: 'Lane', origin: null, archived: false };
  assert.equal(planRestartThread({ thread, lost: [{ status: 'cut' }] }).action, 'note');
  assert.equal(planRestartThread({ thread, lost: [{ status: 'redispatched' }, { status: 'delivered' }] }).action, 'note');
  assert.equal(planRestartThread({ thread, lost: [{ status: 'stale' }] }).reason, RESTART_STALE_REASON);
  assert.equal(planRestartThread({ thread: { ...thread, archived: true }, lost: [{ status: 'cut' }] }).action, 'skip');
  assert.equal(planRestartThread({ thread: { ...thread, origin: 'crw' }, lost: [{ status: 'cut' }] }).action, 'note');
  assert.equal(planRestartThread({ thread: { ...thread, origin: 'imessage' }, lost: [{ status: 'cut' }] }).action, 'report');
});

test('buildRestartNote lists each lost subagent with model, session, start and prompt', () => {
  const incident = { id: 'rs-x', startMs: T0, failAllMs: T0 };
  const lost = [
    { status: 'cut', title: 'Haiku TC#251 r3 test fix', model: 'opus/cc/claude-haiku-5-5', sessionId: 'ses_cut', startedAt: iso(T0 - 400_000), prompt: 'Read PACKET-G1.md and fix the test.' },
    { status: 'finished', title: 'Haiku fix r5 PR 748', model: 'opus/cc/claude-haiku-5-5', sessionId: 'ses_done', startedAt: iso(T0 - 600_000), finishedMs: T0 - 280_000, excerpt: 'Commit 4832395cb.' },
    { status: 'redispatched', title: 'Astra final r3', redo: { title: 'Astra final r3 (retry)', started_at: iso(T0 + 76_000) } },
  ];
  const note = buildRestartNote({ incident, lost, turnCut: true, ocUrl: 'http://127.0.0.1:49374' });
  assert.match(note, /^\[stream-recovery\] Robob restarted at 18:17Z and cancelled 2 background subagent/);
  assert.match(note, /Your own turn was cut off/);
  assert.match(note, /"Haiku TC#251 r3 test fix" \(opus\/cc\/claude-haiku-5-5\), session ses_cut, started 18:11Z: cut off/);
  assert.match(note, /Read PACKET-G1\.md and fix the test\./);
  assert.match(note, /finished at 18:13Z, but its result never reached you/);
  assert.match(note, /Commit 4832395cb\./);
  assert.match(note, /Already handled, no action needed: "Astra final r3" \(session unknown; re-dispatched as "Astra final r3 \(retry\)" at 18:19Z\)/);
  assert.match(note, /pass its session id as the session to continue/);
  const s = buildRestartSummary({ incident: { ...incident, subagents: [{ parentThreadId: 'a' }, { parentThreadId: 'b' }] }, results: [
    { plan: { threadId: 'a', title: 'Crpko kafka cell', action: 'note' }, ok: true, lostSubs: lost },
    { plan: { threadId: 'b', title: 'iMessage', action: 'report' }, ok: true, lostSubs: [lost[0]] },
  ] });
  assert.match(s.text, /^Robob restart at 18:17Z hit 2 thread\(s\): 0 with their own turn cut off, 2 background subagent\(s\) cancelled\./);
  assert.match(s.text, /Noted: Crpko kafka cell \(2 subagent\(s\) to pick up, 1 handled subagent\(s\) listed\)/);
  assert.match(s.text, /iMessage \(iMessage\): lost "Haiku TC#251 r3 test fix" \(ses_cut\)/);
  assert.equal(s.severity, 'attention');
});

// ---------- restartScan with a fake io ----------

function fakeIo({ subs = [], delegated = [], runs = [], threads, later = {}, oc = {}, delivered = new Set(), installerMs = null, runAfter = [], held = {}, messages = {}, active = [] }) {
  const calls = { send: [], telegram: [], commands: [], saves: [] };
  const io = {
    OC_URL: 'http://oc',
    serverRuntime: () => ({ pid: 81615, procStartMs: Date.parse('2026-10-15T18:16:17Z'), readyMs: Date.parse('2026-10-15T18:17:53.316Z') }),
    openCodeRuntime: () => null,
    restartRunsSince: () => runs,
    restartNoteRun: () => null,
    stoppedSince: () => false,
    messageText: (_db, id) => messages[id] ?? '',
    dispatchCommand: async (command) => { calls.commands.push(command); },
    saveState: (state) => { calls.saves.push(JSON.parse(JSON.stringify(state))); },
    cancelledSubagentsSince: () => subs.map((s) => ({ ...s })),
    cancelledDelegatedTasksSince: () => delegated.map((s) => ({ ...s })),
    childRunOutcomeSince: () => null,
    childNativeSession: () => null,
    delegatedStoppedSince: () => false,
    runMessages: () => [],
    subagentParent: () => null,
    threadRoot: () => null,
    subagentsStartedSince: (_db, threadId) => later[threadId] ?? [],
    subagentResultSeen: (_db, _t, _since, ses) => delivered.has(ses),
    turnCutAndIdle: () => false,
    runStartedSince: (_db, threadId) => (runAfter ?? []).includes(threadId),
    queuedRuns: (_db, threadId) => (held[threadId] ?? []),
    activeSessions: async () => new Set(active),
    ocMessages: async (ses) => ({ messages: oc[ses] ?? [], complete: true }),
    ocSession: async (ses) => ({ id: ses, parentID: `${ses}_parent` }),
    getThread: async (id) => threads[id] ?? null,
    robobHealthy: async () => true,
    installerResumePendingMs: () => installerMs,
    sendToThread: async (threadId, text, opts) => { calls.send.push({ threadId, text, ...opts }); return { ok: true }; },
    telegram: (args) => { calls.telegram.push(args); },
  };
  return { io, calls };
}

function delegatedFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table orchestration_v2_projection_threads(thread_id text, payload_json text);
    create table orchestration_v2_projection_runs(run_id text,thread_id text,ordinal integer,status text,requested_at text,completed_at text,payload_json text);
    create table orchestration_v2_projection_turn_items(run_id text,type text,thread_id text,updated_at text);
    create table orchestration_v2_projection_messages(message_id text,thread_id text,run_id text,role text,created_at text,payload_json text);
    create table orchestration_v2_projection_subagents(subagent_id text,thread_id text,run_id text,provider_thread_id text,child_thread_id text,started_at text,completed_at text,origin text,status text,payload_json text);`);
  const task = (id, { status = 'interrupted', origin = 'app_owned', nodeId = `node:delegated-task:${id}`, payload = {}, parent = 'batch' } = {}) => {
    const child = `thread:delegated-task:${id}`;
    const row = { subagent_id: nodeId, thread_id: parent, run_id: `parent-run:${id}`, child_thread_id: child,
      started_at: iso(T0 - 60_000), completed_at: iso(T0 + 1_000) };
    db.prepare('insert into orchestration_v2_projection_subagents values (?,?,?,?,?,?,?,?,?,?)').run(
      row.subagent_id, row.thread_id, row.run_id, null, child, row.started_at, row.completed_at, origin, status,
      JSON.stringify({ id: nodeId, title: `Task ${id}`, model: 'test/model', prompt: `Prompt ${id}`, result: 'Partial work', ...payload }),
    );
    return row;
  };
  const addRun = (id, thread, ordinal, status, requested, completed, payload = {}) => {
    db.prepare('insert into orchestration_v2_projection_runs values (?,?,?,?,?,?,?)').run(id, thread, ordinal, status, iso(requested), completed == null ? null : iso(completed), JSON.stringify(payload));
  };
  const stop = (id, thread, at = T0 + 1_000) => db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?)')
    .run(id, 'run_interrupt_request', thread, iso(at));
  return { db, task, addRun, stop };
}

test('restartScan includes delegated tasks, excludes Stops and distinguishes a later finished child', async () => {
  const { db, task, addRun, stop } = delegatedFixture();
  try {
    const cut = task('cut');
    const finished = task('finished');
    const equal = task('same-time');
    const parentStopped = task('parent-stop');
    const childStopped = task('child-stop');
    task('explicit-cancel', { payload: { completionDelivery: { state: 'disposed' } } });
    task('wrong-kind', { nodeId: 'node:app-other:wrong-kind' });
    task('wrong-origin', { origin: 'provider_native' });
    task('completed', { status: 'completed' });
    stop(parentStopped.run_id, 'batch');
    addRun('child-stopped-run', childStopped.child_thread_id, 1, 'interrupted', T0 - 50_000, T0 + 1_000);
    addRun('held-queued-run', childStopped.child_thread_id, 2, 'queued', T0, null, { queueHeld: true });
    stop('child-stopped-run', childStopped.child_thread_id);
    addRun('equal-run', equal.child_thread_id, 1, 'completed', T0 - 50_000, T0 + 1_000);
    addRun('finished-run', finished.child_thread_id, 1, 'completed', T0 - 50_000, T0 + 2_000);
    db.prepare('insert into orchestration_v2_projection_messages values (?,?,?,?,?,?)').run('m', finished.child_thread_id, 'finished-run', 'assistant', iso(T0 + 1_900), JSON.stringify({ text: 'Finished the work.' }));
    const rows = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    assert.deepEqual(rows.map((r) => r.subagent_id), [cut.subagent_id, finished.subagent_id, equal.subagent_id]);
    assert.equal(rows[0].taskRef, cut.subagent_id);
    assert.equal(rows[0].childThreadId, cut.child_thread_id);
    const { io, calls } = fakeIo({ runs: [run('batch')], threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    io.runMessages = dbIo.runMessages;
    const [report] = await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    const lost = report.results[0].lostSubs;
    assert.deepEqual(lost.map((l) => l.status), ['cut', 'finished', 'cut']);
    const note = calls.send[0].text;
    assert.match(note, /Your own turn was cut off/);
    assert.match(note, /delegated task "Task cut" \(test\/model\), child thread thread:delegated-task:cut: cut off by the restart\. Check it with task_status node:delegated-task:cut before relaunching; relaunch with delegate_task only if it didn't finish and no continuation is active or pending\./);
    assert.match(note, /Original prompt:\n\s*```\nPrompt cut/);
    assert.match(note, /delegated task "Task finished".*: finished at .*Check it with task_status node:delegated-task:finished for the result/);
    assert.match(note, /Finished the work\./);
    assert.doesNotMatch(note, /Task parent-stop|Task child-stop|Task explicit-cancel|Task wrong-kind/);
    assert.doesNotMatch(note, /pass its session id|api\/session\/<ses>/);
    assert.match(calls.telegram[0].text, /0 background subagent\(s\) and 3 delegated task\(s\) interrupted/);
    assert.match(calls.telegram[0].text, /3 delegated task\(s\) to pick up/);
  } finally { db.close(); }
});

test('delegated lookup uses the task node ID and never mistakes an earlier stopped child run for the cut', () => {
  const { db, task, addRun, stop } = delegatedFixture();
  try {
    const row = task('retry', { payload: { id: undefined, taskId: 'not-a-node-id', clientRequestId: 'request-retry' } });
    addRun('old-stop', row.child_thread_id, 1, 'interrupted', T0 - 120_000, T0 - 60_000);
    stop('old-stop', row.child_thread_id, T0 - 60_000);
    addRun('cut-run', row.child_thread_id, 2, 'interrupted', T0 - 50_000, T0 + 1_000,
      { restartContinuationOfRunId: 'old-stop' });
    const [found] = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    assert.equal(found.taskRef, row.subagent_id);
    assert.equal(found.clientRequestId, 'request-retry');
    assert.equal(dbIo.childRunOutcomeSince(db, row.child_thread_id, row.subagent_id, row.completed_at), null);
    assert.equal(dbIo.childRunOutcomeSince(db, null, row.subagent_id, row.completed_at), null);
  } finally { db.close(); }
});

test('a cancelled unstarted buffered notification cannot hide a stopped task run', async () => {
  const { db, task, addRun, stop } = delegatedFixture();
  try {
    const stopped = task('buffered-stop');
    addRun('executed-child', stopped.child_thread_id, 1, 'interrupted', T0 - 50_000, T0,
      { startedAt: iso(T0 - 49_000), delegatedTaskId: stopped.subagent_id });
    stop('executed-child', stopped.child_thread_id, T0);
    addRun('buffered-cancel', stopped.child_thread_id, 2, 'cancelled', T0 - 10_000, T0,
      { startedAt: null, delegatedTaskId: stopped.subagent_id });
    db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?)')
      .run('buffered-cancel', 'notification', stopped.child_thread_id, iso(T0 - 10_000));
    const safe = task('safe');
    addRun('unrelated-stopped', safe.child_thread_id, 1, 'interrupted', T0 - 50_000, T0,
      { delegatedTaskId: 'node:delegated-task:other', startedAt: iso(T0 - 49_000) });
    stop('unrelated-stopped', safe.child_thread_id, T0);
    addRun('safe-run', safe.child_thread_id, 2, 'interrupted', T0 - 20_000, T0 + 1_000,
      { delegatedTaskId: safe.subagent_id, startedAt: iso(T0 - 19_000) });
    assert.deepEqual(dbIo.cancelledDelegatedTasksSince(db, iso(T0)).map((s) => s.subagent_id), [safe.subagent_id]);
    const { io, calls } = fakeIo({ threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    assert.match(calls.send[0].text, /Task safe/);
    assert.doesNotMatch(calls.send[0].text, /Task buffered-stop/);
  } finally { db.close(); }
});

test('a Stop on an unpublished original task’s uncorrelated later run is excluded', async () => {
  const { db, task, addRun, stop } = delegatedFixture();
  try {
    const stopped = task('uncorrelated-stop');
    addRun('original-run', stopped.child_thread_id, 1, 'completed', T0 - 50_000, T0 - 10_000,
      { startedAt: iso(T0 - 49_000) });
    addRun('later-work', stopped.child_thread_id, 2, 'interrupted', T0 - 5_000, T0,
      { startedAt: iso(T0 - 4_000) });
    stop('later-work', stopped.child_thread_id, T0);
    // The task finalizes after the Stop, so the later-stop guard alone cannot catch it.
    const safe = task('uncorrelated-safe');
    addRun('safe-first', safe.child_thread_id, 1, 'completed', T0 - 50_000, T0 - 10_000,
      { startedAt: iso(T0 - 49_000) });
    addRun('other-task-stop', safe.child_thread_id, 2, 'interrupted', T0 - 5_000, T0,
      { startedAt: iso(T0 - 4_000), delegatedTaskId: 'node:delegated-task:another' });
    stop('other-task-stop', safe.child_thread_id, T0);
    assert.deepEqual(dbIo.cancelledDelegatedTasksSince(db, iso(T0)).map((r) => r.subagent_id), [safe.subagent_id]);
    const { io, calls } = fakeIo({ threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    assert.match(calls.send[0].text, /Task uncorrelated-safe/);
    assert.doesNotMatch(calls.send[0].text, /Task uncorrelated-stop/);
  } finally { db.close(); }
});

test('mixed native and delegated tasks share the prompt budget and use separate recovery instructions', async () => {
  const { db, task } = delegatedFixture();
  try {
    const row = task('mixed', { payload: { prompt: 'd'.repeat(2_000) } });
    const { io, calls } = fakeIo({
      subs: [sub('native', 'batch', 1_000, { prompt: 'n'.repeat(2_000) })], threads: { batch: { title: 'Batch' } },
    });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    io.runMessages = dbIo.runMessages;
    await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    const note = calls.send[0].text;
    assert.match(note, /session ses_native.*cut off/);
    assert.match(note, /delegated task "Task mixed".*task_status node:delegated-task:mixed/);
    assert.match(note, /pass its session id as the session to continue/);
    assert.match(note, /Robob will not deliver the native subagents' results, so nothing will wake you for them/);
    assert.match(note, /Read a subagent's output with: curl/);
    assert.equal((note.match(/Original prompt \(start\)/g) ?? []).length, 2);
    assert.doesNotMatch(note, /n{1201}|d{1201}/);
    assert.match(calls.telegram[0].text, /1 background subagent\(s\) and 1 delegated task\(s\) interrupted/);
    assert.match(calls.telegram[0].text, /1 subagent\(s\) to pick up, 1 delegated task\(s\) to pick up/);
    assert.equal(row.child_thread_id, 'thread:delegated-task:mixed');
  } finally { db.close(); }
});

test('delegated child whose finished run has no assistant text is still finished', async () => {
  const { db, task, addRun } = delegatedFixture();
  try {
    const row = task('no-text');
    addRun('completed-no-text', row.child_thread_id, 1, 'completed', T0 - 50_000, T0 + 2_000);
    const { io, calls } = fakeIo({ threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    io.runMessages = dbIo.runMessages;
    const [report] = await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    assert.equal(report.results[0].lostSubs[0].status, 'finished');
    assert.match(calls.send[0].text, /delegated task "Task no-text".*: finished/);
    assert.match(calls.send[0].text, /affected 1 delegated task\(s\)/);
    assert.doesNotMatch(calls.send[0].text, /interrupted 1 delegated task/);
    assert.doesNotMatch(calls.send[0].text, /cut off by the restart/);
  } finally { db.close(); }
});

test('delegated tasks follow their restart continuation, not unrelated child runs', async () => {
  const { db, task, addRun } = delegatedFixture();
  try {
    const running = task('running');
    const done = task('continued');
    const unrelated = task('unrelated');
    for (const r of [running, done, unrelated]) addRun(`${r.subagent_id}:first`, r.child_thread_id, 1, 'cancelled', T0 - 50_000, T0 + 1_000);
    addRun('running-again', running.child_thread_id, 2, 'running', T0 + 2_000, null,
      { restartContinuationOfRunId: `${running.subagent_id}:first` });
    addRun('done-again', done.child_thread_id, 2, 'completed', T0 + 2_000, T0 + 3_000,
      { restartContinuationOfRunId: `${done.subagent_id}:first` });
    addRun('unrelated-followup', unrelated.child_thread_id, 2, 'completed', T0 + 2_000, T0 + 3_000,
      { delegatedTaskId: 'node:delegated-task:some-other-task' });
    const { io, calls } = fakeIo({ threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childRunOutcomeSince = dbIo.childRunOutcomeSince;
    io.runMessages = dbIo.runMessages;
    const [report] = await restartScan(scanArgs({ handled: {}, servers: [] }, { db }), io);
    assert.deepEqual(report.results[0].lostSubs.map((l) => l.status), ['running', 'finished', 'cut']);
    assert.match(calls.send[0].text, /Task running.*a continuation is running or queued.*don't relaunch/);
    assert.match(calls.send[0].text, /Task continued.*: finished/);
    assert.match(calls.send[0].text, /Task unrelated.*: cut off by the restart/);
  } finally { db.close(); }
});

test('stall-watch interrupts are not treated as lost delegated tasks', async () => {
  const { db, task } = delegatedFixture();
  try {
    const row = task('stall');
    const { io, calls } = fakeIo({ threads: { batch: { title: 'Batch' } } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.childNativeSession = () => 'ses_stalled';
    for (const stall of [
      { ses: 'ses_stalled', action: 'opencode', interruptedAt: T0 },
      { threadId: row.child_thread_id, action: 'robob', interruptedAt: T0 },
    ]) {
      const report = await restartScan(scanArgs({ handled: {}, servers: [], stalls: { stall } }, { db }), io);
      assert.equal(report.length, 0);
    }
    assert.equal(calls.send.length + calls.telegram.length, 0);
  } finally { db.close(); }
});

test('a child Stop during deferred recovery removes its saved delegated row', async () => {
  const { db, task, stop } = delegatedFixture();
  try {
    const row = task('late-stop');
    const thread = { title: 'Batch', activeRunId: 'fresh', status: 'running' };
    const { io, calls } = fakeIo({ threads: { batch: thread } });
    io.cancelledDelegatedTasksSince = dbIo.cancelledDelegatedTasksSince;
    io.delegatedStoppedSince = dbIo.delegatedStoppedSince;
    const state = { handled: {}, servers: [] };
    await restartScan(scanArgs(state, { db }), io);
    assert.equal(calls.send.length, 0);
    stop('later-child-run', row.child_thread_id, T0 + 10_000);
    thread.activeRunId = null;
    thread.status = 'completed';
    await restartScan(scanArgs(state, { db }), io);
    assert.equal(calls.send.length, 0);
  } finally { db.close(); }
});

test('an old parent Stop does not suppress a newer delegated task', () => {
  const { db, task, stop } = delegatedFixture();
  try {
    const row = task('after-stop');
    stop(row.run_id, 'batch', T0 - 120_000);
    assert.equal(dbIo.cancelledDelegatedTasksSince(db, iso(T0)).length, 1);
  } finally { db.close(); }
});

test('a completed run with restart-cancelled awaited work is not called finished', () => {
  const { db, task, addRun } = delegatedFixture();
  try {
    const row = task('background-cut');
    addRun('background-cut-run', row.child_thread_id, 1, 'completed', T0 - 50_000, T0 + 2_000,
      { restartCancelledBackgroundWork: [{ kind: 'subagent' }] });
    assert.equal(dbIo.childRunOutcomeSince(db, row.child_thread_id, row.subagent_id, row.completed_at), null);
  } finally { db.close(); }
});

const threads = {
  batch: { threadId: 'batch', title: 'Batch-fix Crpko tickets', origin: null, archived: false },
  kafka: { threadId: 'kafka', title: 'Crpko kafka cell', origin: null, archived: false },
  pbdraft: { threadId: 'pbdraft', title: 'Crpko pbdraft cell', origin: null, archived: false },
  tc3: { threadId: 'tc3', title: 'Crpko tc3 cell', origin: 'imessage', archived: false },
};

const scanArgs = (state, over = {}) => ({
  db: null, state, now: T0 + 10 * 60_000, sinceIso: iso(T0 - 3_600_000), floorMs: T0 - 6 * 3_600_000, log: () => {}, ...over,
});

test('restartScan sends one note per affected thread and one summary, then never repeats', async () => {
  const { io, calls } = fakeIo({
    subs: restartBurst(),
    threads,
    later: { batch: [{ subagent_id: 'r', title: 'worker a3 (resume)', provider_thread_id: pt('ses_new'), started_at: iso(T0 + 150_000) }] },
  });
  const state = { handled: {}, servers: [] };
  const report = await restartScan(scanArgs(state), io);
  assert.equal(report.length, 1);
  assert.deepEqual(calls.send.map((c) => c.threadId).sort(), ['batch', 'kafka', 'pbdraft']);
  for (const c of calls.send) {
    assert.equal(c.clientRequestId, 'rs-20261015T181745Z');
    assert.equal(c.mode, 'queue');
  }
  const batch = calls.send.find((c) => c.threadId === 'batch').text;
  assert.match(batch, /cancelled 2 background subagent/);
  assert.match(batch, /ses_a1/);
  assert.match(batch, /Do task a1\./);
  assert.match(batch, /re-dispatched as "worker a3 \(resume\)"/);
  assert.equal(calls.telegram.length, 1);
  assert.equal(calls.telegram[0].key, 'stream-recovery:rs-20261015T181745Z');
  assert.match(calls.telegram[0].text, /iMessage \(Crpko tc3 cell\)/);
  assert.equal(state.handled['rs-20261015T181745Z'].done, true);
  assert.equal(state.servers.length, 1);

  // Already handled: a later scan does nothing.
  await restartScan(scanArgs(state, { now: T0 + 11 * 60_000 }), io);
  assert.equal(calls.send.length, 3);
  assert.equal(calls.telegram.length, 1);
});

test('restartScan waits only briefly to settle, never for the installer, and never acts on a dry run or seed', async () => {
  assert.ok(RESTART_SETTLE_MS <= 30_000, 'resumes must be fast');
  const fresh = fakeIo({ subs: restartBurst(), threads });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state, { now: T0 + RESTART_SETTLE_MS - 10_000 }), fresh.io);
  assert.equal(fresh.calls.send.length + fresh.calls.telegram.length, 0);
  assert.deepEqual(state.handled, {});

  // Owner, 1 Nov: an installer's pending resume no longer holds the notes back.
  const installer = fakeIo({ subs: restartBurst(), threads, installerMs: T0 - 300_000 });
  await restartScan(scanArgs({ handled: {}, servers: [] }), installer.io);
  assert.deepEqual(installer.calls.send.map((c) => c.threadId).sort(), ['batch', 'kafka', 'pbdraft']);

  const dry = fakeIo({ subs: restartBurst(), threads });
  const report = await restartScan(scanArgs(state, { dryRun: true }), dry.io);
  assert.equal(report[0].results.length, 4);
  assert.equal(dry.calls.send.length + dry.calls.telegram.length, 0);
  assert.deepEqual(state.handled, {});

  const seed = fakeIo({ subs: restartBurst(), threads });
  await restartScan(scanArgs(state, { seed: true }), seed.io);
  assert.equal(seed.calls.send.length + seed.calls.telegram.length, 0);
  assert.equal(state.handled['rs-20261015T181745Z'].summary, 'seeded');
});

test('restartScan reports delivered children for handoffs but skips stale children', async () => {
  const finished = (text) => [{ type: 'assistant', finish: 'stop', time: { created: T0 - 60_000 }, content: [{ type: 'text', text }] }];
  const subs = [
    sub('d1', 'kafka', 0), sub('o1', 'pbdraft', 100, { started_at: iso(T0 - 2 * 86_400_000) }), sub('c1', 'batch', 200),
    sub('h1', 'tc3', 300), sub('f1', 'batch', 400),
  ];
  const { io, calls } = fakeIo({
    subs, threads: { ...threads, tc3: { ...threads.tc3, origin: null } }, delivered: new Set(['ses_d1']),
    runAfter: ['tc3'], held: { batch: [{ held: true }, { held: false }] },
    oc: {
      ses_d1: finished('ok'),
      ses_o1: [{ type: 'assistant', finish: 'tool-calls', time: { created: T0 - 2 * 86_400_000 }, content: [] }],
      // Finished before the restart; OpenCode already handed the result to the parent session.
      ses_h1: finished('review CLEAR'),
      ses_h1_parent: [{ type: 'synthetic', text: '<subagent sessionID="ses_h1" state="completed" description="x">review CLEAR</subagent>' }],
      // Finished, but the parent never saw it.
      ses_f1: finished('fixed in abc123'),
    },
  });
  const state = { handled: {}, servers: [] };
  const [r] = await restartScan(scanArgs(state), io);
  const by = Object.fromEntries(r.results.map((x) => [x.plan.threadId, x]));
   assert.equal(by.kafka.plan.action, 'note');
  assert.equal(by.pbdraft.plan.reason, RESTART_STALE_REASON);
   assert.equal(by.tc3.plan.action, 'note');
  assert.deepEqual(by.tc3.lostSubs.map((l) => l.status), ['delivered']);
  assert.equal(by.batch.plan.action, 'note');
  assert.deepEqual(by.batch.lostSubs.map((l) => l.status), ['cut', 'finished']);
   assert.deepEqual(calls.send.map((c) => c.threadId), ['kafka', 'batch', 'tc3']);
   assert.match(calls.send.find((c) => c.threadId === 'batch').text, /fixed in abc123/);
  assert.match(calls.telegram[0].text, /Queue released: Batch-fix Crpko tickets \(1\)\./);
  assert.match(calls.telegram[0].text, /Skipped: Crpko pbdraft cell \(only stale subagents/);
});

test('a result in the parent history only counts once the parent ran again', async () => {
  const finished = [{ type: 'assistant', finish: 'stop', time: { created: T0 - 60_000 }, content: [{ type: 'text', text: 'review CLEAR' }] }];
  const make = (runAfter) => fakeIo({
    subs: [sub('h1', 'kafka', 0), sub('x', 'pbdraft', 10), sub('y', 'batch', 20)], threads, runAfter,
    oc: { ses_h1: finished, ses_h1_parent: [{ type: 'synthetic', text: '<subagent sessionID="ses_h1" state="completed">review CLEAR</subagent>' }] },
  });
  const idle = make([]);
  const [r1] = await restartScan(scanArgs({ handled: {}, servers: [] }), idle.io);
  assert.equal(r1.results.find((x) => x.plan.threadId === 'kafka').lostSubs[0].status, 'finished');
  const ran = make(['kafka']);
  const [r2] = await restartScan(scanArgs({ handled: {}, servers: [] }), ran.io);
  assert.equal(r2.results.find((x) => x.plan.threadId === 'kafka').lostSubs[0].status, 'delivered');
});

test('cancels from the stall watch interrupting a session are not a restart', async () => {
  const subs = [sub('a', 'x', 0), sub('b', 'y', 10), sub('c', 'z', 20)];
  const stalls = Object.fromEntries(['a', 'b', 'c'].map((k) => [`st-${k}`, { ses: `ses_${k}`, action: 'opencode', interruptedAt: T0 - 2_000 }]));
  const { io, calls } = fakeIo({ subs, threads: {} });
  const report = await restartScan(scanArgs({ handled: {}, servers: [], stalls }), io);
  assert.equal(report.length, 0);
  assert.equal(calls.telegram.length, 0);
});

const run = (threadId, over = {}) => ({
  run_id: `run:thread:${encodeURIComponent(threadId)}:ordinal:19`, thread_id: threadId, ordinal: 19,
  status: 'cancelled', requested_at: iso(T0 - 6 * 3_600_000), started_at: iso(T0 - 6 * 3_600_000 + 60_000),
  completed_at: iso(T0 + 7_000), ...over,
});

test('run-only restarts include failed starts, not interrupted turns or cancelled queued messages', () => {
  const start = { pid: 1, readyMs: T0 + 10_000, procStartMs: T0 - 60_000 };
  const runs = [run('arch'), run('failed', { status: 'failed', started_at: null }),
    run('stop', { status: 'interrupted' }), run('queued', { started_at: null }),
    run('thread:provider:opencode:native-thread:ses_child'), run('old', { completed_at: iso(T0 - 3_600_000) })];
  assert.equal(findRestartIncidents([], { runs }).length, 0);
  const [incident] = findRestartIncidents([], { runs, serverStarts: [start] });
  assert.deepEqual(incident.runs.map((r) => r.thread_id), ['arch', 'failed']);
  assert.equal(incident.subagents.length, 0);
});

test('slow shutdown clusters and run-only threads share one restart', () => {
  const start = { pid: 1, readyMs: T0 + 60_000, procStartMs: T0 - 60_000 };
  const [incident, extra] = findRestartIncidents([sub('a', 'parent', 0), sub('b', 'parent', 30_000)], {
    runs: [run('arch')], serverStarts: [start],
  });
  assert.equal(extra, undefined);
  assert.equal(incident.subagents.length, 2);
  assert.equal(incident.runs.length, 1);
  start.incidentId = incident.id;
  // A sliding lookback dropping the earliest row must not change the key.
  assert.equal(findRestartIncidents([sub('b', 'parent', 30_000)], { serverStarts: [start] })[0].id, incident.id);
});

test('restartScan recovers own turns and crw reviewers without needing cancelled children', async () => {
  const { io, calls } = fakeIo({
    runs: [run('arch'), run('crw', { status: 'failed' })],
    subs: [sub('review', 'crw', 0)],
    threads: { arch: { title: 'Architecture lane' }, crw: { title: 'mobile_app#306', origin: 'crw' } },
  });
  const state = { handled: {}, servers: [] };
  const report = await restartScan(scanArgs(state), io);
  assert.equal(report.runIds.size, 2);
  assert.deepEqual(calls.send.map((s) => s.threadId), ['arch', 'crw']);
  assert.match(calls.send[0].text, /Your own turn was cut off/);
  assert.doesNotMatch(calls.send[0].text, /Lost subagents:|cancelled 0/);
  assert.match(calls.send[0].text, /dirhelper -machineBoot fully wipes \$TMPDIR/);
  assert.match(calls.send[1].text, /ses_review/);
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 2);
});

test('a fast scan notes threads right away and keeps the incident open for a run cut late in the window', async () => {
  // Robob ready at T0+10s, so its start window closes at T0+70s.
  const runs = [run('arch')];
  const threadsById = { arch: { title: 'Architecture lane' }, late: { title: 'Late lane' } };
  const { io, calls } = fakeIo({ runs, threads: threadsById });
  io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state, { now: T0 + 7_000 + RESTART_SETTLE_MS + 1_000 }), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch']);
  assert.equal(calls.telegram.length, 0);
  const id = Object.keys(state.handled)[0];
  assert.equal(state.handled[id].done, false);
  runs.push(run('late', { completed_at: iso(T0 + 60_000) }));
  await restartScan(scanArgs(state, { now: T0 + 60_000 + RESTART_SETTLE_MS + 1_000 }), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch', 'late']);
  assert.equal(Object.keys(state.handled).length, 1);
  await restartScan(scanArgs(state, { now: T0 + 70_000 + RESTART_SETTLE_MS + 1_000 }), io);
  assert.equal(calls.telegram.length, 1);
  assert.equal(state.handled[id].done, true);
  assert.equal(calls.send.length, 2);
});

test('a later delegated cut is sent once as an incremental queued note without delaying the parent', async () => {
  const { db, task } = delegatedFixture();
  try {
    const row = task('late-task');
    // Start with an own-run cut only; the delegated projection appears later.
    const delegated = [];
    const parent = { title: 'Architecture lane', activeRunId: null, status: 'idle' };
    const { io, calls } = fakeIo({ runs: [run('batch')], delegated, threads: { batch: parent } });
    io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
    const state = { handled: {}, servers: [] };
    await restartScan(scanArgs(state, { now: T0 + 30_000 }), io);
    assert.equal(calls.send.length, 1);
    assert.match(calls.send[0].text, /Your own turn was cut off/);
    assert.doesNotMatch(calls.send[0].text, /Task late-task/);
    const [found] = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    found.completed_at = iso(T0 + 40_000);
    delegated.push(found);
    parent.activeRunId = 'parent-continued';
    parent.status = 'running';
    await restartScan(scanArgs(state, { now: T0 + 65_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.equal(calls.send[1].mode, 'queue');
    assert.match(calls.send[1].clientRequestId, /^rs-.*:delegated:[0-9a-f]{64}$/);
    assert.match(calls.send[1].text, /Additional delegated task discovered/);
    assert.match(calls.send[1].text, /Task late-task.*task_status node:delegated-task:late-task/);
    assert.doesNotMatch(calls.send[1].text, /Your own turn was cut off/);
    await restartScan(scanArgs(state, { now: T0 + 95_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.equal(calls.telegram.length, 1);
    assert.match(calls.telegram[0].text, /1 delegated task\(s\) to pick up/);
    assert.match(calls.telegram[0].text, /1 delegated task\(s\) to pick up/);
    assert.equal(row.child_thread_id, 'thread:delegated-task:late-task');
  } finally { db.close(); }
});

test('incremental task retry uses its durable receipt even if send succeeded before state save', async () => {
  const { db, task } = delegatedFixture();
  try {
    task('late-receipt');
    const delegated = [];
    const { io, calls } = fakeIo({ runs: [run('batch')], delegated, threads: { batch: { title: 'Batch' } } });
    io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
    const state = { handled: {}, servers: [] };
    await restartScan(scanArgs(state, { now: T0 + 30_000 }), io);
    const [found] = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    found.completed_at = iso(T0 + 40_000);
    delegated.push(found);
    let receipt = null;
    const send = io.sendToThread;
    io.sendToThread = async (threadId, text, opts) => {
      await send(threadId, text, opts);
      receipt = opts.clientRequestId;
      throw new Error('reply lost after accept');
    };
    io.restartNoteRun = (_db, _id, requestId) => requestId === receipt ? 'receipt-run' : null;
    await restartScan(scanArgs(state, { now: T0 + 65_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.equal(Object.values(state.handled)[0].threads.batch.done, false);
    await restartScan(scanArgs(state, { now: T0 + 95_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.equal(calls.telegram.length, 1);
  } finally { db.close(); }
});

test('a main-note receipt only covers the delegated IDs captured before that send', async () => {
  const { db, task } = delegatedFixture();
  try {
    task('first-attempt');
    task('appeared-after-accept');
    const [first, later] = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    const delegated = [first];
    const { io, calls } = fakeIo({ runs: [run('batch')], delegated, threads: { batch: { title: 'Batch' } } });
    io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
    const state = { handled: {}, servers: [] };
    let mainReceipt = false;
    const send = io.sendToThread;
    io.sendToThread = async (id, text, opts) => {
      await send(id, text, opts);
      if (!opts.clientRequestId.includes(':delegated:')) {
        mainReceipt = true;
        throw new Error('main send accepted but reply lost');
      }
    };
    io.restartNoteRun = (_db, _thread, id) => mainReceipt && !id.includes(':delegated:') ? 'main-note-run' : null;
    await restartScan(scanArgs(state, { now: T0 + 30_000 }), io);
    assert.equal(calls.send.length, 1);
    assert.match(calls.send[0].text, /Task first-attempt/);
    assert.doesNotMatch(calls.send[0].text, /Task appeared-after-accept/);
    later.completed_at = iso(T0 + 40_000);
    delegated.push(later);
    await restartScan(scanArgs(state, { now: T0 + 65_000 }), io);
    await restartScan(scanArgs(state, { now: T0 + 95_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.match(calls.send[1].text, /Task appeared-after-accept/);
    assert.doesNotMatch(calls.send[1].text, /Task first-attempt/);
  } finally { db.close(); }
});

test('late-note send exhaustion identifies the undelivered task in the summary', async () => {
  const { db, task } = delegatedFixture();
  try {
    task('undelivered');
    const delegated = [];
    const { io, calls } = fakeIo({ runs: [run('batch')], delegated, threads: { batch: { title: 'Batch' } } });
    io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
    const state = { handled: {}, servers: [] };
    await restartScan(scanArgs(state, { now: T0 + 30_000 }), io);
    const [late] = dbIo.cancelledDelegatedTasksSince(db, iso(T0));
    late.completed_at = iso(T0 + 40_000);
    delegated.push(late);
    io.sendToThread = async () => { throw new Error('service unavailable'); };
    for (const at of [65_000, 70_000, 95_000]) await restartScan(scanArgs(state, { now: T0 + at }), io);
    assert.equal(calls.telegram.length, 1);
    assert.match(calls.telegram[0].text, /delegated task node:delegated-task:undelivered not noted/);
    assert.equal(calls.telegram[0].severity, 'attention');
  } finally { db.close(); }
});

test('late delegated delivery retries a missing receipt and never includes a task stopped before the retry', async () => {
  const { db, task } = delegatedFixture();
  try {
    task('retry-late');
    task('stopped-late');
    const delegated = [];
    const { io, calls } = fakeIo({ runs: [run('batch')], delegated, threads: { batch: { title: 'Batch' } } });
    io.serverRuntime = () => ({ pid: 7, procStartMs: T0 - 30_000, readyMs: T0 + 10_000 });
    const state = { handled: {}, servers: [] };
    await restartScan(scanArgs(state, { now: T0 + 30_000 }), io);
    for (const row of dbIo.cancelledDelegatedTasksSince(db, iso(T0))) {
      row.completed_at = iso(T0 + 40_000);
      delegated.push(row);
    }
    let stopLate = false;
    io.delegatedStoppedSince = (_db, sub) => stopLate && sub.subagent_id === 'node:delegated-task:stopped-late';
    const send = io.sendToThread;
    let failure = true;
    io.sendToThread = async (...args) => {
      if (failure) { failure = false; throw new Error('unavailable before accept'); }
      return send(...args);
    };
    await restartScan(scanArgs(state, { now: T0 + 65_000 }), io);
    assert.equal(calls.send.length, 1);
    stopLate = true;
    await restartScan(scanArgs(state, { now: T0 + 95_000 }), io);
    assert.equal(calls.send.length, 2);
    assert.match(calls.send[1].text, /Task retry-late/);
    assert.doesNotMatch(calls.send[1].text, /Task stopped-late/);
    assert.equal(calls.telegram.length, 1);
  } finally { db.close(); }
});

test('a stopped unstarted continuation remains a Stop target', () => {
  const { db, task, addRun, stop } = delegatedFixture();
  try {
    const row = task('stopped-start');
    addRun('initial-cut', row.child_thread_id, 1, 'cancelled', T0 - 50_000, T0,
      { startedAt: iso(T0 - 49_000), delegatedTaskId: row.subagent_id });
    addRun('continuation-stop', row.child_thread_id, 2, 'cancelled', T0, T0 + 1_000,
      { startedAt: null, restartContinuationOfRunId: 'initial-cut' });
    stop('continuation-stop', row.child_thread_id, T0 + 500);
    assert.equal(dbIo.cancelledDelegatedTasksSince(db, iso(T0)).length, 0);
  } finally { db.close(); }
});

test('OpenCode-only restarts recover own turns and track sightings separately from Robob', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch', { status: 'failed' })], threads: { arch: { title: 'Architecture' } } });
  io.serverRuntime = () => ({ pid: 8, procStartMs: T0 - 86_400_000, readyMs: T0 - 86_400_000 });
  io.openCodeRuntime = () => ({ service: 'opencode', pid: 9, procStartMs: T0, readyMs: T0 });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 1);
  assert.match(calls.send[0].text, /^\[stream-recovery\] OpenCode restarted/);
  assert.equal(state.servers[1].prevSeenMs, null);
});

test('an OpenCode crash that leaves turns interrupted with no Stop request is a restart; a requested Stop is not', async () => {
  const { io, calls } = fakeIo({
    runs: [
      run('lane', { status: 'interrupted', stop_requested: 0 }),
      run('evaluator', { status: 'interrupted', stop_requested: 0 }),
      run('stopped', { status: 'interrupted', stop_requested: 1 }),
    ],
    threads: { lane: { title: 'Work lane' }, evaluator: { title: 'Evaluator: #16 discussion' }, stopped: { title: 'Stopped by hand' } },
  });
  io.serverRuntime = () => ({ pid: 8, procStartMs: T0 - 86_400_000, readyMs: T0 - 86_400_000 });
  io.openCodeRuntime = () => ({ service: 'opencode', pid: 9, procStartMs: T0, readyMs: T0 });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['lane', 'evaluator']);
  assert.match(calls.send[0].text, /^\[stream-recovery\] OpenCode restarted/);
  assert.match(calls.send[0].text, /Your own turn was cut off/);
  assert.equal(calls.telegram.length, 1);
  assert.match(calls.telegram[0].text, /^OpenCode restart at .* hit 2 thread\(s\): 2 with their own turn cut off/);
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 2);
});

test('handed-off parents still get child session IDs even if every child looks handled', async () => {
  const { io, calls } = fakeIo({ subs: [sub('sol', 'old', 0)], threads: { old: { title: 'Old lane' } },
    later: { old: [{ subagent_id: 'redo', provider_thread_id: pt('ses_sol'), started_at: iso(T0 + 1_000), title: 'Sol resumed' }] },
  });
  await restartScan(scanArgs({ handled: {}, servers: [] }), io);
  assert.equal(calls.send.length, 1);
  assert.match(calls.send[0].text, /session ses_sol; re-dispatched/);
  assert.match(calls.send[0].text, /pass this recovery note, including every listed child session and result/);
});

test('held queues drop only stale coordination pulses and keep old owner messages', async () => {
  const coordId = 'ardud-control:send:arch:coord%3Awake%3Aabc';
  const held = [
    { run_id: 'run:20', held: true, requested_at: iso(T0 - 5 * 3_600_000), user_message_id: coordId },
    { run_id: 'run:21', held: true, requested_at: iso(T0 - 4 * 3_600_000), user_message_id: 'm21' },
    { run_id: 'run:22', held: true, requested_at: iso(T0 - 3_600_000), user_message_id: 'm22' },
    { run_id: 'run:23', held: true, requested_at: iso(T0 - 5 * 3_600_000), user_message_id: 'owner' },
  ];
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: { title: 'Arch', activeRunId: null } }, held: { arch: held },
    messages: { [coordId]: '[coord] 4 unacked deliveries. Read coord inbox.', m21: '[lane-pulse] 4 unacked deliveries.', m22: '[lane-pulse] recent', owner: '[coord] Please investigate this quoted pulse.' },
  });
  const state = { handled: {}, servers: [] };
  const [result] = await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.commands.map((c) => [c.type, c.runId]), [
    ['queued-run.cancel', 'run:20'], ['queue.resume', undefined],
  ]);
  assert.match(calls.send[0].text, /run:20, queued/);
  assert.match(calls.send[0].text, /held 3 queued message/);
  assert.equal(result.results[0].queueOk, true);
  await restartScan(scanArgs(state), io);
  assert.equal(calls.commands.length, 2);
});

test('queue retry after a sent note never sends the note again', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: { title: 'Arch', activeRunId: null } },
    held: { arch: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  let tries = 0;
  io.dispatchCommand = async (command) => { calls.commands.push(command); if (++tries === 1) throw new Error('lost queue reply'); };
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 1);
  assert.equal(Object.values(state.handled)[0].done, false);
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.commands.length, 2);
  assert.equal(calls.commands[0].commandId, calls.commands[1].commandId);
  assert.equal(Object.values(state.handled)[0].done, true);
});

test('durable message receipt covers a crash between send and state save', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: { title: 'Arch', activeRunId: 'recovery-run', status: 'running' } },
    held: { arch: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  io.restartNoteRun = () => 'recovery-run';
  await restartScan(scanArgs({ handled: {}, servers: [] }), io);
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.commands.map((c) => c.type), ['queue.resume']);
});

test('fresh running turns and OpenCode-active parents get no note or queue changes', async () => {
  for (const over of [{ activeRunId: 'fresh', status: 'running' }, { nativeSessionId: 'ses_busy' }, { pendingRequest: { kind: 'question' } }]) {
    const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: { title: 'Arch', ...over } }, active: ['ses_busy'],
      held: { arch: [{ held: true }] },
    });
    await restartScan(scanArgs({ handled: {}, servers: [] }), io);
    assert.equal(calls.send.length + calls.commands.length, 0);
  }
});

test('busy threads defer queue recovery until idle without resending to recovered siblings', async () => {
  const thread = { title: 'Arch', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('arch'), run('other')], threads: { arch: thread, other: { title: 'Other' } },
    held: { arch: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  const state = { handled: {}, servers: [] };
  for (let i = 0; i < 4; i++) await restartScan(scanArgs(state), io);
  assert.equal(Object.values(state.handled)[0].done, false);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['other']);
  thread.activeRunId = null;
  thread.status = 'completed';
  await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['other', 'arch']);
  assert.deepEqual(calls.commands.map((c) => c.type), ['queue.resume']);
  assert.equal(Object.values(state.handled)[0].done, true);
});

test('a later user Stop is a barrier to recovering an older cancelled turn', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: { title: 'Arch', status: 'interrupted' } },
    held: { arch: [{ held: true }] },
  });
  io.stoppedSince = () => true;
  const [report] = await restartScan(scanArgs({ handled: {}, servers: [] }), io);
  assert.equal(report.results[0].plan.reason, 'stopped after the restart');
  assert.equal(calls.send.length + calls.commands.length, 0);
});

test('deferral neither consumes failure retries nor expires at the discovery lookback', async () => {
  const thread = { title: 'Arch', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: thread },
    held: { arch: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  let state = { handled: {}, servers: [] };
  for (let i = 0; i < 4; i++) await restartScan(scanArgs(state), io);
  // Like a later LaunchAgent invocation, reload state after the normal 3h
  // discovery window and even the 6h age floor no longer contain the cut.
  state = JSON.parse(JSON.stringify(state));
  io.restartRunsSince = () => [];
  thread.activeRunId = null;
  thread.status = 'completed';
  const send = io.sendToThread;
  io.sendToThread = async () => { throw new Error('one transient failure'); };
  const args = scanArgs(state, { now: T0 + 8 * 3_600_000, sinceIso: iso(T0 + 5 * 3_600_000), floorMs: T0 + 2 * 3_600_000 });
  await restartScan(args, io);
  assert.equal(Object.values(state.handled)[0].done, false);
  assert.equal(Object.values(state.handled)[0].threads.arch.failures, 1);
  io.sendToThread = send;
  await restartScan(args, io);
  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.commands.map((c) => c.type), ['queue.resume']);
  assert.equal(Object.values(state.handled)[0].done, true);
});

test('an exhausted failing thread does not finalize its still-busy sibling', async () => {
  const busy = { title: 'Arch', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('arch'), run('broken')], threads: { arch: busy, broken: { title: 'Broken' } } });
  const send = io.sendToThread;
  io.sendToThread = async (id, text, opts) => { if (id === 'broken') throw new Error('down'); return send(id, text, opts); };
  const state = { handled: {}, servers: [] };
  for (let i = 0; i < 4; i++) await restartScan(scanArgs(state), io);
  assert.equal(Object.values(state.handled)[0].done, false);
  assert.equal(Object.values(state.handled)[0].threads.broken.failures, 3);
  busy.activeRunId = null;
  busy.status = 'completed';
  await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch']);
  assert.equal(Object.values(state.handled)[0].done, true);
});

test('a turn starting while child history is read is rechecked before mutations', async () => {
  const { io, calls } = fakeIo({ subs: [sub('x', 'arch', 0)], threads: {} });
  let reads = 0;
  io.getThread = async () => ({ title: 'Arch', activeRunId: ++reads > 1 ? 'new' : null });
  await restartScan(scanArgs({ handled: {}, servers: [] }), io);
  assert.equal(reads, 2);
  assert.equal(calls.send.length + calls.commands.length, 0);
});

test('successful thread delivery is not retried when a sibling fails', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch'), run('other')], threads: { arch: { title: 'Arch' }, other: { title: 'Other' } } });
  const send = io.sendToThread;
  let failed = false;
  io.sendToThread = async (id, text, opts) => {
    if (id === 'other' && !failed) { failed = true; throw new Error('temporarily down'); }
    return send(id, text, opts);
  };
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch', 'other']);
});

test('read-only projection queries use real payload shapes and exclude Stops and children', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table orchestration_v2_projection_threads(thread_id text, payload_json text);
    create table orchestration_v2_projection_runs(run_id text,thread_id text,ordinal integer,status text,requested_at text,completed_at text,payload_json text);
    create table orchestration_v2_projection_turn_items(run_id text,type text,thread_id text,updated_at text);
    create table orchestration_v2_projection_messages(message_id text,thread_id text,run_id text,payload_json text);`);
  const add = (id, status, startedAt, parentThreadId = null) => {
    const r = run(id, { status });
    db.prepare('insert into orchestration_v2_projection_threads values (?,?)').run(id, JSON.stringify({ lineage: { parentThreadId, rootThreadId: parentThreadId ?? id }, activeRunId: null }));
    db.prepare('insert into orchestration_v2_projection_runs values (?,?,?,?,?,?,?)').run(r.run_id, id, r.ordinal, status, r.requested_at, r.completed_at,
      JSON.stringify({ startedAt, queueHeld: true, userMessageId: `msg:${id}` }));
  };
  add('mcp:03976a70', 'cancelled', iso(T0 - 4_000));
  add('failed-start', 'failed', null);
  add('user-stop', 'interrupted', iso(T0 - 4_000));
  add('cancelled-queue', 'cancelled', null);
  add('child', 'cancelled', iso(T0 - 4_000), 'parent');
  add('queued', 'queued', null);
  add('starting', 'cancelled', null);
  add('crash-cut', 'interrupted', iso(T0 - 4_000));
  db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?)').run(run('starting').run_id, 'user_message', 'starting', iso(T0));
  db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?)').run(run('user-stop').run_id, 'run_interrupt_request', 'user-stop', iso(T0 + 1_000));
  const candidates = restartRunsSince(db, iso(T0));
  assert.deepEqual(candidates.map((r) => r.thread_id), ['mcp:03976a70', 'failed-start', 'user-stop', 'starting', 'crash-cut']);
  const [incident] = findRestartIncidents([], { runs: candidates, serverStarts: [{ readyMs: T0 + 10_000 }] });
  assert.deepEqual(incident.runs.map((r) => r.thread_id), ['mcp:03976a70', 'failed-start', 'starting', 'crash-cut']);
  assert.equal(stoppedSince(db, 'user-stop', iso(T0)), true);
  assert.equal(stoppedSince(db, 'crash-cut', iso(T0)), false);
  assert.equal(stoppedSince(db, 'mcp:03976a70', iso(T0)), false);
  assert.equal(queuedRuns(db, 'queued')[0].held, true);
  const id = 'rs-20261016T191520Z';
  db.prepare('insert into orchestration_v2_projection_messages values (?,?,?,?)').run(`ardud-control:send:mcp:03976a70:${id}`, 'mcp:03976a70', 'note-run', '{}');
  assert.equal(restartNoteRun(db, 'mcp:03976a70', id), 'note-run');
  assert.equal(restartNoteRun(db, 'other', id), null);
  db.close();
});

test('a Stop request excludes a failed or cancelled run inside a server window; a later Stop on an old failed run bars the thread', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table orchestration_v2_projection_turn_items(run_id text,type text,thread_id text,updated_at text);`);
  const stopped = [
    { run_id: 'stop-failed', thread_id: 'stop-failed', status: 'failed', completed_at: iso(T0 + 1_000), stop_requested: 1 },
    { run_id: 'stop-cancelled', thread_id: 'stop-cancelled', status: 'cancelled', completed_at: iso(T0 + 1_000), started_at: iso(T0), dispatched: 1, stop_requested: 1 },
  ];
  const [incident] = findRestartIncidents([], { runs: stopped, serverStarts: [{ readyMs: T0 + 10_000 }] });
  assert.equal(incident, undefined);
  db.prepare('insert into orchestration_v2_projection_turn_items values (?,?,?,?)').run('old-failed', 'run_interrupt_request', 'old-failed', iso(T0 + 2_000));
  assert.equal(stoppedSince(db, 'old-failed', iso(T0)), true);
  assert.equal(stoppedSince(db, 'old-failed', iso(T0 + 5_000)), false);
  db.close();
});

test('a burst of cancelled subagents alone does not make an uncut interrupted turn a restart casualty', () => {
  const cancelled = (i) => ({ subagent_id: `s${i}`, thread_id: `parent${i}`, provider_thread_id: `pt${i}`, status: 'cancelled', completed_at: iso(T0 + i * 1_000), origin: 'provider_native' });
  const turn = run('lonely', { status: 'interrupted', stop_requested: 0, completed_at: iso(T0 + 7_000) });
  const [incident] = findRestartIncidents([cancelled(0), cancelled(1), cancelled(2)], { runs: [turn], serverStarts: [] });
  assert.ok(incident);
  assert.deepEqual(incident.runs, []);
});

// ---------- hold-back window and summary naming ----------

const READY = Date.parse('2026-10-15T18:17:53.316Z');
const afterWindow = (state) => scanArgs(state, { now: READY + RESTART_RESUME_WINDOW_MS + 60_000 });

test('a thread still busy past the hold-back window counts as resumed: no note, held queue released', async () => {
  const busy = { title: 'Crpko tc cell', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('tc')], threads: { tc: busy },
    held: { tc: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length + calls.commands.length + calls.telegram.length, 0);
  assert.equal(Object.values(state.handled)[0].done, false);
  const [report] = await restartScan(afterWindow(state), io);
  assert.equal(report.results[0].plan.action, 'resumed');
  assert.equal(report.results[0].plan.reason, RESTART_RESUMED_REASON);
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.commands.map((c) => c.type), ['queue.resume']);
  assert.equal(calls.telegram.length, 1);
  assert.match(calls.telegram[0].text, /Resumed by themselves \(no note\): Crpko tc cell \(turn cut\)\./);
  assert.match(calls.telegram[0].text, /Queue released: Crpko tc cell \(1\)\./);
  assert.equal(Object.values(state.handled)[0].done, true);
  await restartScan(afterWindow(state), io);
  assert.equal(calls.send.length + calls.telegram.length, 1);
});

test('past the window a thread that ran again and went idle is resumed; one with no later run still gets its note', async () => {
  const { io, calls } = fakeIo({ runs: [run('moved'), run('stuck')], runAfter: ['moved'],
    threads: { moved: { title: 'Moved on' }, stuck: { title: 'Stuck lane' } },
  });
  const [report] = await restartScan(afterWindow({ handled: {}, servers: [] }), io);
  const by = Object.fromEntries(report.results.map((r) => [r.plan.threadId, r.plan.action]));
  assert.deepEqual(by, { moved: 'resumed', stuck: 'note' });
  assert.deepEqual(calls.send.map((c) => c.threadId), ['stuck']);
  assert.match(calls.send[0].text, /Your own turn was cut off/);
});

test('a busy thread that goes idle inside the window gets the note; the window does not apply once it was sent', async () => {
  const thread = { title: 'Arch', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('arch')], threads: { arch: thread } });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.equal(calls.send.length, 0);
  thread.activeRunId = null;
  thread.status = 'completed';
  await restartScan(scanArgs(state, { now: READY + RESTART_RESUME_WINDOW_MS - 60_000 }), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch']);
  assert.equal(Object.values(state.handled)[0].done, true);
});

test('the window counts from when Robob was ready, not from the shutdown cancels', async () => {
  const busy = { title: 'Arch', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('arch', { completed_at: iso(T0 - 20 * 60_000) })], threads: { arch: busy } });
  // Robob came back 20 min after the shutdown cancel; it has been up for 20 min.
  io.serverRuntime = () => ({ pid: 5, procStartMs: T0 - 60_000, readyMs: T0 });
  const state = { handled: {}, servers: [{ pid: 4, readyMs: T0 - 86_400_000, lastSeenMs: T0 - 21 * 60_000 }] };
  const [report] = await restartScan(scanArgs(state, { now: T0 + 20 * 60_000 }), io);
  assert.equal(report.results[0].plan.reason, 'fresh turn is running');
  assert.equal(calls.send.length + calls.telegram.length, 0);
});

test('the summary waits until every thread settles and names each one by bucket', async () => {
  const busy = { title: 'Crpko cell-risk (resume 10-15)', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({
    runs: [run('bo'), run('risk'), run('imsg'), run('gone')],
    subs: [sub('k1', 'kafka', 1_000), sub('k2', 'kafka', 1_100)],
    later: { kafka: [{ subagent_id: 'r', title: 'worker k2 (resume)', provider_thread_id: pt('ses_r'), started_at: iso(T0 + 120_000) }] },
    threads: {
      bo: { title: 'Crpko cell-bo lane' }, risk: busy, imsg: { title: 'iMessage', origin: 'imessage' },
      gone: { title: 'Old lane', archived: true }, kafka: { title: 'Crpko kafka cell' },
    },
    held: { bo: [{ run_id: 'h1', held: true, requested_at: iso(T0) }] },
  });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  assert.equal(calls.telegram.length, 0);
  assert.deepEqual(calls.send.map((c) => c.threadId).sort(), ['bo', 'kafka']);
  await restartScan(afterWindow(state), io);
  assert.equal(calls.send.length, 2);
  assert.equal(calls.telegram.length, 1);
  const text = calls.telegram[0].text;
  assert.match(text, /^Robob restart at 18:17Z hit 5 thread\(s\): 4 with their own turn cut off, 2 background subagent\(s\) cancelled\./);
  assert.match(text, /Noted: Crpko cell-bo lane \(turn cut\); Crpko kafka cell \(1 subagent\(s\) to pick up, 1 handled subagent\(s\) listed\)\./);
  assert.doesNotMatch(text, /\(0\)/);
  assert.match(text, /Resumed by themselves \(no note\): Crpko cell-risk \(resume 10-15\) \(turn cut\)\./);
  assert.match(text, /Queue released: Crpko cell-bo lane \(1\)\./);
  assert.match(text, /Skipped: Old lane \(archived\)\./);
  assert.match(text, /iMessage \(iMessage\): turn cut; the thread was not told\./);
  assert.equal(calls.telegram[0].severity, 'attention');
});

test('buildRestartSummary counts threads from results too and labels own-turn notes', () => {
  const incident = { startMs: T0, failAllMs: T0, subagents: [], runs: [{ thread_id: 'a' }, { thread_id: 'a' }, { thread_id: 'b' }] };
  const s = buildRestartSummary({ incident, results: [
    { plan: { threadId: 'a', title: 'Lane A', action: 'note' }, ok: true, turnCut: true, lostSubs: [] },
    { plan: { threadId: 'b', title: null, action: 'skip', reason: 'stopped after the restart' }, ok: true, lostSubs: [] },
  ] });
  assert.match(s.text, /^Robob restart at 18:17Z hit 2 thread\(s\): 2 with their own turn cut off, 0 background/);
  assert.match(s.text, /Noted: Lane A \(turn cut\)\./);
  assert.match(s.text, /Skipped: b \(stopped after the restart\)\./);
  assert.equal(s.severity, 'info');
});

test('inside the window a thread that ran again and went idle still gets the note (it never learned its turn was cut)', async () => {
  const thread = { title: 'cell-devops2', activeRunId: 'coord-wake', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('d2')], runAfter: ['d2'], threads: { d2: thread } });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  thread.activeRunId = null;
  thread.status = 'completed';
  await restartScan(scanArgs(state, { now: T0 + 20 * 60_000 }), io);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['d2']);
});

test('a sent note is never re-sent or relabelled past the window; only its held queue is released', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch')], runAfter: ['arch'],
    threads: { arch: { title: 'Arch', activeRunId: 'another', status: 'running' } },
    held: { arch: [{ run_id: 'h', held: true, requested_at: iso(T0) }] },
  });
  io.restartNoteRun = () => 'note-run';
  const [report] = await restartScan(afterWindow({ handled: {}, servers: [] }), io);
  assert.equal(report.results[0].plan.action, 'note');
  assert.equal(report.results[0].plan.reason, 'note already sent');
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.commands.map((c) => c.type), ['queue.resume']);
});

test('past the window archived, stopped and iMessage threads never get a queue release; dry runs change nothing', async () => {
  const held = [{ run_id: 'h', held: true, requested_at: iso(T0) }];
  const make = () => fakeIo({ runs: [run('gone'), run('stop'), run('imsg')], runAfter: ['gone', 'stop', 'imsg'],
    threads: { gone: { title: 'Gone', archived: true }, stop: { title: 'Stopped' }, imsg: { title: 'iMessage', origin: 'imessage', activeRunId: 'x' } },
    held: { gone: held, stop: held, imsg: held },
  });
  const live = make();
  live.io.stoppedSince = (_db, id) => id === 'stop';
  const state = { handled: {}, servers: [] };
  const [report] = await restartScan(afterWindow(state), live.io);
  assert.deepEqual(report.results.map((r) => r.plan.action), ['skip', 'skip', 'report']);
  assert.equal(live.calls.send.length + live.calls.commands.length, 0);
  const dry = make();
  const dryState = { handled: {}, servers: [] };
  await restartScan({ ...afterWindow(dryState), dryRun: true }, dry.io);
  assert.equal(dry.calls.send.length + dry.calls.commands.length + dry.calls.telegram.length + dry.calls.saves.length, 0);
  assert.deepEqual(dryState.handled, {});
});

test('a thread Robob cannot find is retried before the summary names it', async () => {
  const { io, calls } = fakeIo({ runs: [run('arch'), run('ghost')], threads: { arch: { title: 'Arch' } } });
  const state = { handled: {}, servers: [] };
  for (let i = 0; i < 2; i++) await restartScan(scanArgs(state), io);
  assert.equal(calls.telegram.length, 0);
  await restartScan(scanArgs(state), io);
  assert.equal(calls.telegram.length, 1);
  assert.match(calls.telegram[0].text, /Skipped: ghost \(not found in Robob\)\./);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['arch']);
});

test('leftover state from the previous version still gets a summary naming every thread, and finished state is slimmed', async () => {
  const busy = { title: 'Busy', activeRunId: 'fresh', status: 'running' };
  const { io, calls } = fakeIo({ runs: [run('old'), run('busy')], threads: { old: { title: 'Old' }, busy } });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state), io);
  const entry = Object.values(state.handled)[0];
  delete entry.threads.old.result;
  await restartScan(afterWindow(state), io);
  assert.equal(calls.telegram.length, 1);
  assert.match(calls.telegram[0].text, /Resumed by themselves \(no note\): Busy \(turn cut\)\./);
  assert.match(calls.telegram[0].text, /Skipped: old \(handled earlier\)\./);
  const done = Object.values(state.handled)[0];
  assert.equal(done.done, true);
  assert.equal(done.incident, undefined);
  assert.deepEqual(done.threads.old, { done: true, noteSent: true, queueOk: undefined });
});

// ---------- no mission hand-off ----------

test('every cut thread is noted here; nothing is handed to another recovery and the summary names no mission', async () => {
  const { io, calls } = fakeIo({
    subs: restartBurst(), runs: [run('kafka')], threads,
    held: { kafka: [{ run_id: 'held', held: true, requested_at: iso(T0) }] },
  });
  const state = { handled: {}, servers: [] };
  const [report] = await restartScan(scanArgs(state), io);
  assert.deepEqual(calls.send.map((c) => c.threadId).sort(), ['batch', 'kafka', 'pbdraft']);
  assert.deepEqual(calls.commands.map((c) => [c.type, c.threadId]), [['queue.resume', 'kafka']]);
  assert.ok(report.results.every((r) => r.plan.action !== 'mission'));
  assert.doesNotMatch(calls.telegram[0].text, /[Mm]ission/);
  assert.equal(state.handled['rs-20261015T181745Z'].done, true);
  assert.equal(state.handled['rs-20261015T181745Z'].missionReport, undefined);
});
