import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { observed, clean, recordFailure } from '../toollog.mjs';
import { fixture } from './support.mjs';
import * as recovery from '../../stream-recovery/lib/io.mjs';
import { parseCutoverStatus } from '../../stream-recovery/lib/harness.mjs';
import { assertReplicaPath } from '../../stream-recovery/lib/readonly-db.mjs';
import * as catalog from '../../catalog-guard/lib/io.mjs';
import { check } from '../../catalog-guard/cli.mjs';
import * as reauth from '../../robob-watch/checks/9router-claude-reauth/supervisor.mjs';
import { acquireLease } from '../../robob-watch/checks/9router-claude-reauth/lease.mjs';

const privateText = 'sk-private user@example.invalid /private/credential';
function setup(t) {
  const log = fixture(t);
  for (const paths of [recovery.PATHS, catalog.PATHS]) {
    const before = { ...paths };
    paths.ocPassword = join(log.root, 'password');
    paths.dataDir = log.root;
    paths.control = [join(log.root, 'control.json')];
    t.after(() => Object.assign(paths, before));
  }
  writeFileSync(recovery.PATHS.ocPassword, privateText);
  const env = { T3_CONTROL_URL:process.env.T3_CONTROL_URL, T3_CONTROL_TOKEN:process.env.T3_CONTROL_TOKEN };
  process.env.T3_CONTROL_URL = 'http://fixture.invalid';
  process.env.T3_CONTROL_TOKEN = privateText;
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const rejects = async (code, work, status) => {
    const before = log.rows().length;
    await assert.rejects(observed('test', 'fixture.error', work), error => error.code === code);
    const row = log.rows().slice(before).find(row => row.name === 'fixture.error');
    assert.deepEqual(row.error, {tag:code, message:code});
    assert.equal(row.props?.httpStatus, status);
    assert.ok(!JSON.stringify(log.rows()).includes(privateText));
  };
  return { ...log, rejects };
}

test('HTTP status is a finite number on thrown errors and explicit props', async t => {
  const {rows} = fixture(t);
  for (const value of [503, 0, -1, 200.5, NaN, Infinity, -Infinity, '503', null, false, {}, []]) {
    const error = Object.assign(new Error(privateText), {code:'CONTROL_HTTP', httpStatus:value});
    await assert.rejects(observed('test', 'fixture.http', () => { throw error; }), e => e === error);
    const expected = Number.isFinite(value) ? {httpStatus:value} : undefined;
    assert.deepEqual(rows().at(-1).props, expected);
    assert.deepEqual(clean({component:'test',name:'fixture.http',kind:'error',props:{httpStatus:value}}).props, expected);
    assert.deepEqual(rows().at(-1).error, {tag:'CONTROL_HTTP',message:'CONTROL_HTTP'});
    recordFailure('test', 'fixture.direct', error);
    assert.deepEqual(rows().at(-1).props, expected);
    assert.deepEqual(rows().at(-1).error, {tag:'CONTROL_HTTP',message:'CONTROL_HTTP'});
  }
});

test('control configuration, cutover parsing and replica guards emit stable codes', async t => {
  const {root,rejects} = setup(t);
  const config = join(root, 'private.json');
  writeFileSync(config, '{}'); chmodSync(config, 0o644);
  await rejects('CONTROL_CONFIG_PERMISSIONS', () => recovery.controlConfig({T3_CONTROL_TOKEN_FILE:config}, root));
  chmodSync(config, 0o600); writeFileSync(config, privateText);
  await rejects('CONTROL_CONFIG_INVALID', () => recovery.controlConfig({T3_CONTROL_TOKEN_FILE:config}, root));
  await rejects('CONTROL_AUTH_MISSING', () => recovery.controlConfig({}, root));
  await rejects('CUTOVER_STATUS_INVALID', () => parseCutoverStatus({ok:true,cutover:{active:privateText}}));
  await rejects('REPLICA_PATH_INVALID', () => assertReplicaPath('file:private'));
  await rejects('REPLICA_LIVE_PATH', () => assertReplicaPath(join(root, '.robob/userdata/statev2.sqlite'), root));
  await rejects('OPENCODE_SESSION_INVALID', () => recovery.ocChildren(privateText));
  const bun = recovery.PATHS.bun;
  recovery.PATHS.bun = join(root, 'absent');
  t.after(() => { recovery.PATHS.bun = bun; });
  await rejects('TELEGRAM_NOTIFY_FAILED', () => recovery.telegram({text:privateText,key:'fixture'}));
});

test('control HTTP failures include status without response text, paths or status in the tag', async t => {
  const {rejects} = setup(t);
  for (const status of [401, 404, 503, 200]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ok:false,message:privateText}, {status}));
    await rejects('CONTROL_HTTP', () => recovery.ctl('GET', '/private'), status);
    await rejects('CONTROL_HTTP', () => catalog.harnessCutoverStatus(), status);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ok:true,cutover:{active:privateText}}));
  await rejects('CUTOVER_STATUS_INVALID', () => catalog.harnessCutoverStatus());
  t.mock.method(globalThis, 'fetch', async () => new Response(privateText, {status:502}));
  await rejects('OPENCODE_HTTP', () => recovery.ocSession('ses_fixture'), 502);
  await rejects('OPENCODE_HTTP', () => catalog.serviceSlugs(), 502);
});

test('catalog validation emits codes before transport', async t => {
  const {rejects,root} = setup(t);
  await rejects('CATALOG_INSTANCE_INVALID', () => check({}, {INSTANCE_ID:privateText}));
  await rejects('CATALOG_INSTANCE_INVALID', () => catalog.refreshProviders({instanceId:privateText}));
  await rejects('CATALOG_REQUIREMENTS_INVALID', () => catalog.configuredWatch({CATALOG_GUARD_REQUIRED:'[42]'}));
  delete process.env.T3_CONTROL_URL; delete process.env.T3_CONTROL_TOKEN;
  const path = join(root, 'control.json');
  writeFileSync(path, '{}', {mode:0o600});
  await rejects('CONTROL_AUTH_MISSING', () => catalog.harnessCutoverStatus());
  writeFileSync(path, '{}'); chmodSync(path, 0o644);
  await rejects('CONTROL_CONFIG_PERMISSIONS', () => catalog.harnessCutoverStatus());
});

for (const [code,event] of [
  ['CONTROL_WS_TIMEOUT',null],
  ['CONTROL_WS_EXIT',{type:'message',data:JSON.stringify({_tag:'Exit',exit:{_tag:'Failure',message:privateText}})}],
  ['CONTROL_WS_DEFECT',{type:'message',data:JSON.stringify({_tag:'Defect',message:privateText})}],
  ['CONTROL_WS_ERROR',{type:'error',message:privateText}],
  ['CONTROL_WS_CLOSED',{type:'close'}],
  ['ECONNREFUSED',{type:'error',error:Object.assign(new Error(privateText), {code:'ECONNREFUSED',syscall:'connect'})}],
]) test(`both control WebSocket clients emit ${code}`, async t => {
  const {rejects,rows} = setup(t);
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        if (event) {
          const {type,...fields} = event;
          this.dispatchEvent(Object.assign(new Event(type), fields));
        }
      });
    }
    close() {}
    send() {}
    set binaryType(_) {}
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  if (code === 'ECONNREFUSED') {
    for (const work of [() => recovery.dispatchCommand({type:privateText}, {timeoutMs:1}),
      () => catalog.refreshProviders({timeoutMs:1})]) {
      await assert.rejects(observed('test', 'fixture.socket', work), error => error.code === 'CONTROL_WS_ERROR');
      const row = rows().at(-1);
      assert.deepEqual(row.error, {tag:'ECONNREFUSED',message:'ECONNREFUSED'});
      assert.equal(row.props.errno, 'ECONNREFUSED');
      assert.equal(row.props.target, 'ws://fixture.invalid:80');
      assert.equal(row.props.syscall, 'connect');
      assert.equal(row.props.attemptNo, 1);
      assert.equal(row.props.step, 'fixture.socket');
      assert.ok(!JSON.stringify(row).includes(privateText));
    }
  } else {
    await rejects(code, () => recovery.dispatchCommand({type:privateText}, {timeoutMs:1}));
    await rejects(code, () => catalog.refreshProviders({timeoutMs:1}));
  }
});

const model = {instanceId:'opencode',model:'opus/cx/gpt-6.1-terra',variant:'max'};
const connection = {id:'alpha',provider:'claude',authType:'oauth',isActive:true,reauthRequiredAt:'2026-11-01T00:00:00Z'};
function supervisor() {
  const incident = {id:'incident',accountId:'alpha',marker:connection.reauthRequiredAt,attempts:1,blocked:false,notified:false,nextAt:0};
  const active = {incidentId:incident.id,leaseId:'lease',requestId:'request',threadId:'thread',phase:'sent',sends:1,nextSendAt:0,runId:null};
  const state = {version:1,incidents:[],active:null};
  let owner = null;
  const ctx = {now:()=>1_000_000, load:()=>state, save:()=>{}, providers:async()=>({connections:[connection]}),
    leaseOwner:()=>owner, acquireLease:id=>{owner={kind:'auto',id};}, releaseLease:()=>true,
    available:async()=>true, notificationAvailable:async()=>true, thread:async()=>null,
    create:async()=>({threadId:state.active.threadId,model}), notify:async key=>({id:reauth.notificationId(key),created:true}),
    notificationState:async()=> 'sent'};
  const activate = () => {state.incidents=[incident];state.active=active;owner={kind:'auto',id:active.leaseId};};
  return {ctx,state,incident,active,activate};
}

test('supervisor outward failures retain distinct operational codes', async t => {
  const {rejects,root} = setup(t);
  writeFileSync(join(root,'journal.json'), privateText);
  await rejects('REAUTH_STATE_INVALID', () => reauth.readState(join(root,'journal.json')));
  await rejects('REAUTH_CONNECTION_INVALID', () => reauth.assertCleared({connections:[]}, 'absent'));
  await rejects('REAUTH_DELIVERY_UNKNOWN', () => reauth.notificationState({}, 'fixture'));
  const cases = [
    ['REAUTH_PROVIDERS_INVALID', h=>{h.ctx.providers=async()=>({connections:[{provider:'claude'}]});}],
    ['ROUTER_UNAVAILABLE', h=>{h.ctx.routerUnavailableLimitMs=0;h.ctx.providers=async()=>{throw new reauth.RouterUnavailableError([6,15]);};}],
    ['REAUTH_DETECTOR_UNKNOWN', h=>{h.ctx.enforceSafetyFence=true;h.ctx.notificationAvailable=async()=>false;}],
    ['REAUTH_LEASE_ORPHANED', h=>{h.ctx.leaseOwner=()=>({kind:'unknown'});}],
    ['REAUTH_CONTROL_UNAVAILABLE', h=>{h.ctx.available=async()=>false;}],
    ['REAUTH_NOTIFY_UNAVAILABLE', h=>{h.ctx.notificationAvailable=async()=>false;}],
    ['REAUTH_CONTROL_STATUS_UNAVAILABLE', h=>{h.activate();h.ctx.thread=async()=>{throw new Error(privateText);};}],
    ['REAUTH_CONTROL_STATUS_INVALID', h=>{h.activate();h.ctx.thread=async()=>({thread:{}});}],
    ['REAUTH_MODEL_UNAVAILABLE', h=>{h.activate();h.ctx.thread=async()=>({thread:{threadId:'thread',state:'running'}});}],
    ['REAUTH_THREAD_NOT_TERMINAL', h=>{h.activate();h.ctx.thread=async()=>({thread:{threadId:'thread',state:'unknown',model}});}],
    ['REAUTH_LAUNCH_UNKNOWN', h=>{h.ctx.create=async()=>{throw new Error(privateText);};}],
    ['REAUTH_LAUNCH_UNVERIFIED', h=>{h.ctx.create=async()=>null;}],
    ['REAUTH_LEASE_RELEASE_FAILED', h=>{h.activate();h.active.phase='finishing';h.ctx.releaseLease=()=>false;}],
    ['REAUTH_LEASE_UNKNOWN', h=>{h.activate();h.active.phase='finishing';h.ctx.leaseOwner=()=>({kind:'unknown'});}],
  ];
  for (const [code,prepare] of cases) {
    const h = supervisor(); prepare(h);
    await rejects(code, () => reauth.tick(h.ctx));
  }
});

test('provider authentication and non-retryable HTTP responses emit codes', async t => {
  const {root,rejects} = setup(t);
  mkdirSync(join(root,'auth'));
  writeFileSync(join(root,'machine-id'), ''); writeFileSync(join(root,'auth/cli-secret'), '');
  await rejects('REAUTH_AUTH_MISSING', () => reauth.liveProviders({data:root}));
  writeFileSync(join(root,'machine-id'), privateText); writeFileSync(join(root,'auth/cli-secret'), privateText);
  await rejects('ROUTER_HTTP', () => reauth.liveProviders({data:root,fetch:async()=>new Response(privateText,{status:401})}), 401);
});

test('bounded notification subprocess failures keep codes and discard process output', async t => {
  const {root,rejects} = setup(t);
  const abort = new AbortController(); abort.abort();
  await rejects('REAUTH_NOTIFY_ABORTED', () => reauth.runBoundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:abort.signal}));
  await rejects('REAUTH_NOTIFY_TIMEOUT', () => reauth.runBoundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:1}));
  await rejects('REAUTH_NOTIFY_TOO_LARGE', () => reauth.runBoundedCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(300000))"]));
  await rejects('REAUTH_NOTIFY_UNAVAILABLE', () => reauth.runBoundedCommand(join(root,'missing'),[]));
});

test('lease subprocess failures and invalid notification replies emit safe codes', async t => {
  const {rejects} = setup(t);
  const originalSync = childProcess.spawnSync, originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawnSync = originalSync; childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  childProcess.spawnSync = () => ({status:1,stderr:privateText});
  syncBuiltinESMExports();
  await rejects('REAUTH_LEASE_SERIALIZATION', () => acquireLease('/fixture/lease', 'auto'));
  childProcess.spawnSync = () => ({status:0,stdout:privateText});
  syncBuiltinESMExports();
  await rejects('REAUTH_LEASE_RESULT_INVALID', () => acquireLease('/fixture/lease', 'auto'));
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.unref = () => {};
    queueMicrotask(() => { child.stdout.write(privateText); child.emit('exit',0); });
    return child;
  };
  syncBuiltinESMExports();
  await rejects('REAUTH_NOTIFY_INVALID', () => reauth.telegramCommand(['fixture']));
});
