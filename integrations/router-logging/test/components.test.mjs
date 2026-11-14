import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support.mjs';
import {check} from '../../catalog-guard/cli.mjs';
import {recoveryIo} from '../../stream-recovery/lib/logging.mjs';
import {stallScan} from '../../stream-recovery/lib/stallwatch.mjs';
import {restartScan} from '../../stream-recovery/lib/restartwatch.mjs';

test('catalog decisions, refresh success, refresh failure and read failure are observable', async t=>{
  const {rows}=fixture(t);
  let repaired=false, fail=false;
  const fake={INSTANCE_ID:'opencode',readState:()=>({}),readJson:()=>({enabled:true,checkedAt:'2020-01-01',models: repaired ? [{slug:'surplus/glm-5.3-flash'}] : []}),configuredWatch:()=>({}),harnessCutoverStatus:async()=>({active:false,completed:true}),serviceSlugs:async()=>['surplus/glm-5.3-flash'],writeState:()=>{},refreshProviders:async()=>{if(fail)throw new Error('sk-fixture-do-not-log');repaired=true;return {status:'ready',slugs:['surplus/glm-5.3-flash']};}};
  assert.equal(await check({cache:'fixture',dryRun:false},fake),0);
  repaired=false;fail=true;
  assert.equal(await check({cache:'fixture',dryRun:false},fake),1);
  fake.serviceSlugs=async()=>{throw new Error('fixture@example.invalid')};
  assert.equal(await check({cache:'fixture',dryRun:false},fake),1);
  for(const ok of [true,false])assert.ok(rows().some(r=>r.name==='catalog.refresh'&&r.ok===ok));
  assert.ok(rows().some(r=>r.name==='catalog.decision'&&r.props.action==='service-error'));
  assert.ok(!JSON.stringify(rows()).includes('sk-fixture-do-not-log'));
});
test('each recovery mutation keeps its result and logs success and failure without message bodies',async t=>{
  const {rows}=fixture(t);
  for(const name of ['sendToThread','interruptThread','dispatchCommand','ocInterrupt']) {
    const io=recoveryIo({[name]:async body=>{if(body.fail)throw new Error('private prompt');return 'ok';}});
    assert.equal(await io[name]({prompt:'private prompt'}),'ok');
    await assert.rejects(()=>io[name]({fail:true,prompt:'private prompt'}),/private prompt/);
    assert.deepEqual(rows().filter(r=>r.name===`recovery.${name}`).map(r=>r.ok),[true,false]);
  }
  assert.ok(!JSON.stringify(rows()).includes('private prompt'));
});
test('stall and restart scans log success and failure at their actual boundaries',async t=>{
  const {rows}=fixture(t);
  const state={handled:{},watch:{},stalls:{},servers:[],ghosts:{}};
  const io={recoveryPauseMs:()=>null,installerResumePendingMs:()=>null,harnessCutoverStatus:async()=>({active:false,completed:false}),activeSessions:async()=>new Set(),activeThreads:async()=>[],serverRuntime:()=>null,openCodeRuntime:()=>null,assertReplicaFresh:()=>{},cancelledSubagentsSince:()=>[],cancelledDelegatedTasksSince:()=>[],restartRunsSince:()=>[],stoppedSince:()=>false,saveState:()=>{}};
  const args={state,now:Date.now(),db:{},sinceIso:'2026-11-13T00:00:00Z',floorMs:0,log:()=>{}};
  await stallScan(args,io);
  await restartScan(args,io);
  io.harnessCutoverStatus=async()=>{throw new Error('private prompt')};
  await assert.rejects(()=>stallScan(args,io));
  io.assertReplicaFresh=()=>{throw new Error('private prompt')};
  await assert.rejects(()=>restartScan(args,io));
  for(const name of ['stall.scan','restart.scan']) assert.deepEqual(rows().filter(r=>r.name===name).map(r=>r.ok),[true,false]);
});

test('supervisor recorded account states: needed/start/ok/fail without host lease commands',async t=>{
  const {tick,threadIdFor}=await import('../../robob-watch/checks/9router-claude-reauth/supervisor.mjs');
  const {rows}=fixture(t);
  const MODEL={instanceId:'opencode',model:'opus/cx/gpt-6.1-terra',variant:'max'};
  let state={version:1,incidents:[],active:null},owner=null,thread=null,fail=false;
  let connections=[{id:'fixture-account',provider:'claude',authType:'oauth',isActive:true,reauthRequiredAt:'2026-11-13T00:00:00Z'}];
  const ctx={now:()=>1000000,load:()=>structuredClone(state),save:s=>{state=structuredClone(s)},providers:async()=>({connections}),leaseOwner:()=>owner,acquireLease:id=>{owner={kind:'auto',id}},releaseLease:()=>{owner=null;return true},available:async()=>true,notificationAvailable:async()=>true,thread:async()=>thread?{thread}:null,create:async input=>{if(fail)throw new Error('sk-fixture-do-not-log');const run={runId:'fixture-run',status:'running',model:MODEL};thread={threadId:threadIdFor(input.clientRequestId),state:'running',model:MODEL,run,recentRuns:[run]};return {threadId:thread.threadId,runId:run.runId,status:'running',model:MODEL}},lastAssistant:async()=>'',notify:async()=>{throw new Error('unexpected notification')}};
  await tick(ctx);
  connections=[];thread.state='idle';thread.run.status='completed';await tick(ctx);
  connections=[{id:'fixture-other',provider:'claude',authType:'oauth',isActive:true,reauthRequiredAt:'2026-11-13T00:00:00Z'}];thread=null;fail=true;
  await assert.rejects(()=>tick(ctx),/launch outcome unknown/);
  for(const name of ['relogin.needed','relogin.start','relogin.ok','relogin.fail'])assert.ok(rows().some(r=>r.name===name));
  assert.ok(!JSON.stringify(rows()).includes('sk-fixture-do-not-log'));
});

test('guard and instrumentation composition records each mutation once', async t=>{
  const {guardRecoveryIo}=await import('../../stream-recovery/lib/pause.mjs');
  const {act}=await import('../../stream-recovery/cli.mjs');
  const {rows}=fixture(t);
  let sends=0;
  const thread={threadId:'t',model:{instanceId:'opencode'},nativeSessionId:'ses_fixture',latestRunId:'r'};
  const io={harnessCutoverStatus:async()=>({active:false,completed:false}),assertReplicaFresh:()=>{},assertThreadInReplica:()=>{},getThread:async()=>thread,sendToThread:async()=>{sends++}};
  const g={plan:{threadId:'t',action:'note'},thread,sourceRuns:[],staleHeld:[],held:[],lost:[],reply:null,forms:[],orphans:[]};
  await act({db:{},incident:{id:'fixture',runs:[],subagents:[]},g,dryRun:false},guardRecoveryIo(io));
  assert.equal(sends,1);
  assert.equal(rows().filter(r=>r.name==='recovery.sendToThread').length,1);
});

test('stream scan summary records exactly one successful or failed Telegram send', async t=>{
  const {scan}=await import('../../stream-recovery/cli.mjs');
  const {rows}=fixture(t);
  const now=Date.now();
  for(const fail of [false,true]){
    const result={plan:{threadId:'t',title:'fixture',action:'skip',reason:'archived'},ok:true,lost:[],reply:null,forms:[],orphans:[],error:null};
    const incident={id:'stream-fixture',startMs:now-120000,endMs:now-120000,failAllMs:now-120000,runs:[{thread_id:'t'}],subagents:[]};
    const state={handled:{'stream-fixture':{incident,done:false,threads:{t:{done:true,result}}}},servers:[],stalls:{},watch:{},ghosts:{}};
    let sends=0;
    const io={now:()=>now,PATHS:{db:'fixture'},openDb:()=>({close(){}}),acquireLock:()=>()=>{},loadState:()=>state,saveState:()=>{},assertReplicaFresh:()=>{},serverRuntime:()=>null,openCodeRuntime:()=>null,cancelledSubagentsSince:()=>[],cancelledDelegatedTasksSince:()=>[],restartRunsSince:()=>[],failedRunsSince:()=>[],failedSubagentsSince:()=>[],activeSessions:async()=>new Set(),activeThreads:async()=>[],installerResumePendingMs:()=>null,harnessCutoverStatus:async()=>({active:false,completed:false}),telegram:()=>{sends++;if(fail)throw new Error('private prompt')}};
    await scan({dryRun:false,maxAgeHours:6},io);
    assert.equal(sends,1);
    assert.equal(state.handled['stream-fixture'].telegram,!fail);
  }
  const notifications=rows().filter(r=>r.name==='recovery.telegram');
  assert.deepEqual(notifications.map(r=>r.ok),[true,false]);
  assert.equal(notifications[1].kind,'error');
  assert.ok(!JSON.stringify(notifications).includes('private prompt'));
});
