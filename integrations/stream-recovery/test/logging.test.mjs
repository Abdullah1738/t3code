import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferThread, timedScan } from '../lib/logging.mjs';
import { stallScan } from '../lib/stallwatch.mjs';
import { fixture } from '../../router-logging/test/support.mjs';

test('scan deferrals count distinct ancestry units and aggregate nested maxima', async t => {
  const { rows } = fixture(t);
  const behind = ahead => Object.assign(new Error('thread is newer than Robob replica; recovery deferred'), {
    code:'REPLICA_BEHIND_THREAD',replicaGeneration:42,replicaAgeMs:1_000,threadAheadMs:ahead,
  });
  await timedScan('stream', {}, async outer => {
    await timedScan('restart', outer, async inner => {
      assert.equal(deferThread(inner, 'parent', behind(1_500)), true);
      deferThread(inner, 'parent', behind(2_500));
      deferThread(inner, 'other', behind('unknown'));
    });
    deferThread(outer, 'parent', behind(500));
    assert.equal(deferThread(outer, 'stale', {code:'REPLICA_UNAVAILABLE'}), false);
  });
  for (const lane of ['stream','restart']) {
    const row = rows().find(row => row.name === `${lane}.scan`);
    assert.equal(row.ok, true);
    assert.deepEqual(row.props, {deferredThreads:2,maxThreadAheadMs:2_500});
  }
});

test('scan timings aggregate repeated IO, preserve sync results, and bound output', async t => {
  const { rows } = fixture(t);
  let clock = 0;
  t.mock.method(performance, 'now', () => ++clock);
  const error = new TypeError('sk-private fixture@example.invalid');
  const methods = ['openDb','acquireLock','serverRuntime','cancelledSubagentsSince','restartRunsSince','activeSessions','getThread'];
  const io = Object.fromEntries(methods.map(k => [k, () => 42]));
  io.getThread = async () => { throw error; };
  await assert.rejects(timedScan('stream', io, async timed => {
    for (const k of methods.slice(0,-1)) assert.equal(timed[k]('sk-private'), 42);
    assert.equal(timed.openDb(),42);
    return timed.getThread();
  }),e=>e===error);
  const phases = rows().filter(r => r.name === 'stream.phase');
  assert.equal(phases.length, 6);
  assert.equal(phases.find(r => r.props.phase === 'openDb').props.count, 2);
  assert.equal(phases.reduce((n,r)=>n+r.props.failed,0),1);
  assert.equal(phases.reduce((n,r)=>n+r.props.count,0),8);
  assert.equal(rows().find(r=>r.name==='stream.scan').error.tag,'TypeError');
  assert.equal(rows().find(r=>r.name==='stream.scan').props.phase,'getThread');
  assert.ok(!JSON.stringify(rows()).includes('sk-private'));
  assert.ok(!JSON.stringify(rows()).includes('fixture@example.invalid'));
});

for (const phase of ['harnessCutoverStatus', 'activeSessions']) test(`stall scan identifies fetch failure in ${phase}`, async t => {
  const { rows } = fixture(t);
  const error = new TypeError('fetch failed', {cause:Object.assign(new Error('https://user:password@example.invalid/?token=sk-private'), {code:'ECONNREFUSED'})});
  const io = {
    harnessCutoverStatus:async () => ({}),
    activeSessions:async () => new Set(),
    [phase]:async () => {throw error;},
  };
  await assert.rejects(stallScan({state:{watch:{},stalls:{}},now:Date.now(),dryRun:true,log:()=>{}}, io), value=>value===error);
  const row = rows().find(row=>row.name==='stall.scan');
  assert.deepEqual(row.error,{tag:'ECONNREFUSED',message:'fetch failed'});
  assert.equal(row.props.phase,phase);
  const timing = rows().find(row=>row.name==='stall.phase' && row.props.phase===phase);
  assert.equal(timing.props.failed,1);
  for (const secret of ['example.invalid','password','sk-private']) assert.ok(!JSON.stringify(rows()).includes(secret));
});

for (const async of [false, true]) test(`nested scan errors retain the failed fixed IO name (${async ? 'async' : 'sync'})`, async t => {
  const { rows } = fixture(t);
  const error = Object.freeze(new TypeError('fetch failed', {cause:{code:'UND_ERR_SOCKET'}}));
  const fail = () => {throw error;};
  const io = {activeSessions:async ? async () => fail() : fail};
  await assert.rejects(timedScan('stream',io, outer => timedScan('restart',outer, inner=>inner.activeSessions())), value=>value===error);
  for (const lane of ['stream','restart']) {
    const row=rows().find(row=>row.name===`${lane}.scan`);
    assert.deepEqual(row.error,{tag:'UND_ERR_SOCKET',message:'fetch failed'});
    assert.equal(row.props.phase,'activeSessions');
  }
});

test('only the escaping error contributes a phase and unknown IO is not trusted', async t => {
  const { rows } = fixture(t);
  const caught = new Error('private');
  const escaping = Object.assign(new Error('private'), {phase:'activeSessions',op:'getThread'});
  const io={getThread:async()=>{throw caught;},unknown:async()=>{throw escaping;}};
  await assert.rejects(timedScan('stream',io,async timed=>{
    await assert.rejects(timed.getThread(),e=>e===caught);
    return timed.unknown();
  }),e=>e===escaping);
  assert.equal(rows().find(row=>row.name==='stream.scan').props.phase,undefined);
  await timedScan('stream',io,async timed=>{
    await assert.rejects(timed.getThread(),e=>e===caught);
  });
  assert.equal(rows().filter(row=>row.name==='stream.scan').at(-1).props.phase,undefined);
});
