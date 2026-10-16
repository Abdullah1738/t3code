import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRestartIncidents, serverStartWindow, trackServer, findRedispatch, normTitle, childOutcome,
  planRestartThread, buildRestartNote, buildRestartSummary, restartIncidentId, RESTART_STALE_REASON,
} from '../lib/detect.mjs';
import { restartScan, RESTART_SETTLE_MS } from '../lib/restartwatch.mjs';

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
  assert.equal(planRestartThread({ thread, lost: [{ status: 'redispatched' }, { status: 'delivered' }] }).action, 'skip');
  assert.equal(planRestartThread({ thread, lost: [{ status: 'stale' }] }).reason, RESTART_STALE_REASON);
  assert.equal(planRestartThread({ thread: { ...thread, archived: true }, lost: [{ status: 'cut' }] }).action, 'skip');
  assert.equal(planRestartThread({ thread: { ...thread, origin: 'crw' }, lost: [{ status: 'cut' }] }).action, 'skip');
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
  assert.match(note, /Already handled, no action needed: "Astra final r3" \(re-dispatched as "Astra final r3 \(retry\)" at 18:19Z\)/);
  assert.match(note, /pass its session id as the session to continue/);
  const s = buildRestartSummary({ incident: { ...incident, subagents: [{ parentThreadId: 'a' }, { parentThreadId: 'b' }] }, results: [
    { plan: { threadId: 'a', title: 'Crpko kafka cell', action: 'note' }, ok: true, lostSubs: lost },
    { plan: { threadId: 'b', title: 'iMessage', action: 'report' }, ok: true, lostSubs: [lost[0]] },
  ] });
  assert.match(s.text, /^Robob restart at 18:17Z cancelled 2 background subagent\(s\) in 2 thread\(s\)\./);
  assert.match(s.text, /Told to pick them up: Crpko kafka cell \(2\)/);
  assert.match(s.text, /iMessage \(iMessage\): lost "Haiku TC#251 r3 test fix" \(ses_cut\)/);
  assert.equal(s.severity, 'attention');
});

// ---------- restartScan with a fake io ----------

function fakeIo({ subs, threads, later = {}, oc = {}, delivered = new Set(), installerMs = null, runAfter = [], held = {} }) {
  const calls = { send: [], telegram: [] };
  const io = {
    OC_URL: 'http://oc',
    serverRuntime: () => ({ pid: 81615, procStartMs: Date.parse('2026-10-15T18:16:17Z'), readyMs: Date.parse('2026-10-15T18:17:53.316Z') }),
    cancelledSubagentsSince: () => subs.map((s) => ({ ...s })),
    subagentParent: () => null,
    threadRoot: () => null,
    subagentsStartedSince: (_db, threadId) => later[threadId] ?? [],
    subagentResultSeen: (_db, _t, _since, ses) => delivered.has(ses),
    turnCutAndIdle: () => false,
    runStartedSince: (_db, threadId) => (runAfter ?? []).includes(threadId),
    queuedRuns: (_db, threadId) => (held[threadId] ?? []),
    activeSessions: async () => new Set(),
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
    assert.equal(c.mode, 'auto');
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

test('restartScan waits to settle, for the installer, and never acts on a dry run or seed', async () => {
  const fresh = fakeIo({ subs: restartBurst(), threads });
  const state = { handled: {}, servers: [] };
  await restartScan(scanArgs(state, { now: T0 + RESTART_SETTLE_MS - 10_000 }), fresh.io);
  assert.equal(fresh.calls.send.length + fresh.calls.telegram.length, 0);
  assert.deepEqual(state.handled, {});

  const installer = fakeIo({ subs: restartBurst(), threads, installerMs: T0 - 300_000 });
  await restartScan(scanArgs(state), installer.io);
  assert.equal(installer.calls.send.length, 0);
  assert.deepEqual(state.handled, {});

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

test('restartScan skips threads whose subagents finished and were delivered, or were idle for hours', async () => {
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
  assert.equal(by.kafka.plan.action, 'skip');
  assert.equal(by.pbdraft.plan.reason, RESTART_STALE_REASON);
  assert.equal(by.tc3.plan.action, 'skip');
  assert.deepEqual(by.tc3.lostSubs.map((l) => l.status), ['delivered']);
  assert.equal(by.batch.plan.action, 'note');
  assert.deepEqual(by.batch.lostSubs.map((l) => l.status), ['cut', 'finished']);
  assert.deepEqual(calls.send.map((c) => c.threadId), ['batch']);
  assert.match(calls.send[0].text, /fixed in abc123/);
  assert.match(calls.telegram[0].text, /Queued messages Robob is holding .*Batch-fix Crpko tickets \(1\)/);
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
