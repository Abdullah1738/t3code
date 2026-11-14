import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedScan } from '../lib/logging.mjs';
import { fixture } from '../../router-logging/test/support.mjs';

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
  assert.ok(!JSON.stringify(rows()).includes('sk-private'));
  assert.ok(!JSON.stringify(rows()).includes('fixture@example.invalid'));
});
