import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, emit, observed } from '../toollog.mjs';

import {fixture} from './support.mjs';
test('replica diagnostics only retain finite numbers or unknown', async t => {
  const {rows} = fixture(t);
  for (const value of [42, 0, -5_001, 'unknown', 'sk-private', '/home/fixture@example.invalid', '42', NaN, Infinity, -Infinity, null, false, [], {}]) {
    const error = Object.assign(new Error('Robob replica is not ready'), {
      code:'REPLICA_BEHIND_THREAD', replicaGeneration:value, replicaAgeMs:value, threadAheadMs:value,
      deferredThreads:value, maxThreadAheadMs:value,
    });
    await assert.rejects(observed('test', 'fixture.replica', () => { throw error; }), e => e === error);
    const safe = Number.isFinite(value) ? value : 'unknown';
    const expected = {replicaGeneration:safe,replicaAgeMs:safe,threadAheadMs:safe,deferredThreads:safe,maxThreadAheadMs:safe};
    assert.deepEqual(rows().at(-1).props, expected);
    assert.deepEqual(clean({component:'test',name:'fixture.replica',kind:'error',props:error}).props, expected);
  }
  assert.ok(!JSON.stringify(rows()).includes('sk-private'));
  assert.ok(!JSON.stringify(rows()).includes('fixture@example.invalid'));
});
test('observed derives stable causes and only keeps fixed operational messages', async t => {
  const {rows} = fixture(t);
  const cases = [
    [Object.assign(new Error('Robob replica is stale; recovery deferred'), {code:'REPLICA_UNAVAILABLE'}), 'REPLICA_UNAVAILABLE'],
    [Object.assign(new Error('sk-private fixture@example.invalid /home/fixture@example.invalid/x'), {code:'ETIMEDOUT'}), 'ETIMEDOUT'],
    [new TypeError('private prompt'), 'TypeError'],
    [{code:'invalid code',name:'RangeError',message:'Bearer private'}, 'RangeError'],
    [{code:'sk-private',name:'invalid name'}, 'operation_failed'],
    [{code:'x'.repeat(65),name:'SyntaxError'}, 'SyntaxError'],
    [{code:'',name:'Error/path@example.invalid'}, 'operation_failed'],
    [new Error('Robob replica is stale; recovery deferred sk-private'), 'Error'],
    [null, 'operation_failed'],
  ];
  for (const [error, tag] of cases) {
    await assert.rejects(observed('test', 'fixture.failure', () => {throw error;}), value => value === error);
    assert.equal(rows().at(-1).error.tag, tag);
  }
  assert.equal(rows()[0].error.message, 'Robob replica is stale; recovery deferred');
  for (const [result, tag] of [[{ok:false,tag:'not_ready',code:'OTHER'},'not_ready'],
    [{ok:false,code:'ECONNRESET'},'ECONNRESET'], [{ok:false,tag:'fixture@example.invalid'},'operation_failed']]) {
    assert.equal(await observed('test','fixture.result',()=>result), result);
    assert.equal(rows().at(-1).error.tag,tag);
  }
  const serialized = JSON.stringify(rows());
  for (const secret of ['sk-private','fixture@example.invalid','private prompt','Bearer private']) assert.ok(!serialized.includes(secret));
  assert.ok(rows().every(r => r.error.message.length <= 300));
});

test('hostile metadata and broken writes never replace results or errors', async t => {
  fixture(t);
  const hostile = new Proxy({}, {get(_target, key){if (key === 'then') return undefined; throw new Error('getter');},ownKeys(){throw new Error('keys');}});
  assert.equal(await observed('test','fixture.result',()=>hostile),hostile);
  assert.equal(await observed('test','fixture.result',()=>42,hostile),42);
  await assert.rejects(observed('test','fixture.error',()=>{throw hostile;},hostile),e=>e===hostile);
});
test('JS schema, privacy, errors, permissions and fail-open writes', async t => {
  const {root, rows} = fixture(t);
  emit('test','fixture.ok',{kind:'perf',ok:true,durationMs:1,ids:{account:'fixture@example.invalid',key:'sk-fixture-do-not-log'},props:{model:'cx/gpt-image-2',prompt:'private prompt',email:'fixture@example.invalid',tag:'sk-fixture-do-not-log'},error:{tag:'http_502',message:'private prompt fixture@example.invalid sk-fixture-do-not-log'}});
  const serialized = JSON.stringify(rows());
  for(const secret of ['fixture@example.invalid','sk-fixture-do-not-log','private prompt']) assert.ok(!serialized.includes(secret));
  assert.equal(rows()[0].tool,'9router');
  assert.match(rows()[0].ts,/\.\d{3}Z$/);
  assert.equal(fs.statSync(root).mode & 0o777,0o700);
  assert.equal(fs.statSync(join(root,fs.readdirSync(root).find(x=>x.endsWith('.ndjson')))).mode & 0o777,0o600);
  process.env.ROUTER_LOG_DIR = join(root, 'broken'); fs.writeFileSync(process.env.ROUTER_LOG_DIR,'x');
  assert.doesNotThrow(()=>emit('test','fixture.bad'));
  assert.equal(await observed('test','fixture.bad',()=>42),42);
  const error=new Error('private prompt');
  await assert.rejects(observed('test','fixture.bad',()=>{throw error}), e=>e===error);
  assert.doesNotThrow(()=>emit('test','fixture.bad',{ids:null}));
  assert.equal(clean({component:'test',name:'bad email',kind:'event'}),null);
});
test('JS cap keeps errors, emits one cap marker, and expires only day files', t=>{
  const {root}=fixture(t);
  fs.writeFileSync(join(root,'2000-01-01.ndjson'),'old'); fs.writeFileSync(join(root,'rollup-2000-01-01.json'),'old');fs.writeFileSync(join(root,'keep'),'keep');
  emit('test','fixture.first');
  assert.ok(!fs.existsSync(join(root,'2000-01-01.ndjson')));assert.ok(!fs.existsSync(join(root,'rollup-2000-01-01.json')));assert.ok(fs.existsSync(join(root,'keep')));
  const path=join(root,new Date().toISOString().slice(0,10)+'.ndjson');fs.truncateSync(path,50*1024*1024);
  emit('test','fixture.drop');emit('test','fixture.drop');emit('test','fixture.error',{kind:'error',error:{tag:'http_502'}});
  const fd=fs.openSync(path,'r'),buf=Buffer.alloc(4096);const n=fs.readSync(fd,buf,0,4096,50*1024*1024);fs.closeSync(fd);const tail=buf.subarray(0,n).toString();
  assert.equal(tail.split('log.cap').length-1,1);assert.ok(!tail.includes('fixture.drop'));assert.ok(tail.includes('fixture.error'));
});
